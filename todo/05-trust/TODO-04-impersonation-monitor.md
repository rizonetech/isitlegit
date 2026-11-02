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
| 2 | §2 | Daily run with DNS liveness checks | §1, D03 T04 §15 | [x] |
| 3 | §3 | Screening new or changed live pages | §2, D03 T04 §1 | [x] |
| 4 | §4 | Full pipeline on | §3, §9, D04 T02 §6 | [x] |
| 5 | §5 | Monitor alerts and takedown pack | §4 | [x] |
| 6 | §6 | Demo lookalike site found by | §5 | [ ] |
| 7 | §7 | Certificate-transparency search for | §5 | [ ] |
| 8 | §8 | Daily re-screen of live candidates | §3 | [x] |
| 9 | §9 | Spark second look before walkthrough | §3 | [x] |
| 10 | §10 | Findings exported to | §5 | [ ] |
| 11 | §11 | Settled pages handed to Loupe capture | §4, D03 T04 §46 | [ ] |
| 12 | §12 | Monitor case allowance and quality | §4 | [ ] |

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

**Corrected 2026-11-01** (completion review, `docs/reviews/05-trust/D05-T04-s2.md`, gaps 5 to 12): a capture is owed while the host's DNS differs from that of its last successful capture (`captured_dns_hash`), so a run stopped after the DNS write still captures (5); an HTTP error answer, or none, is a failed capture that keeps the last good one (6); a host with no HTTPS listener is captured once over HTTP and the address recorded (`capture_url`, 7); correction 7's refresh is "over a week old, the 50 oldest": it is now the oldest captures that the next six days' room of 50 cannot absorb, so a lone capture is refreshed on its seventh day and a cohort of every candidate never passes a week, at most 50 captures a run and the rest counted as `deferred` (8); Glimmer as the item below (9); the reservation is settled to the deadline of the wake's own request, and a refused or failed settlement is recorded and retried in its own Workflow step (10); the run row is written `running` first, finished with its real end time, and a failed run is recorded and thrown so the step retries it (11); the tests cover the scheduled entrypoint, the browser's lifecycle, the real ledger and an interrupted run (12). Migration 0063, never on main, gains `captured_dns_hash`, `capture_url` and `deferred` in place.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Add the `scheduled` handler and cron. Done when: a test invocation processes one organisation's candidates.

- [x] Add migration `0063_monitor.sql` (**Corrected 2026-10-31:** was `0013_monitor.sql`) with `monitor_hosts` (`org_id`, `domain`, `resolves`, `dns_hash`, `dns_at`, `content_hash`, `captured_at`, `capture_key`, `capture_failed_at`, `capture_failures`, `first_seen`, `last_seen`, `status`; unique on `org_id`, `domain`) and `monitor_runs` (corrections 8 and 13). Done when: a migration test applies it and the columns read back.
- [x] Add `"triggers": { "crons": ["15 4 * * *"] }` (06:15 SAST) and a `scheduled` handler running the monitor as a Workflow per organisation. Done when: `wrangler deploy --dry-run` lists the `MONITOR` Workflow, `wrangler.jsonc` lists the cron (**Corrected 2026-11-01:** was "the dry run lists the cron"; Wrangler 4's dry run prints no schedules, the existing three included, so the cron is read from the config and dispatched by `test/monitor/cron.test.ts`), and `test/monitor/cron.test.ts` runs one organisation.
- [x] Resolve candidates with DoH (`cloudflare-dns.com`, A and AAAA) at most 20 in parallel, and fetch the homepage of new or changed resolving hosts through Browser Run (downloads blocked). Done when: unchanged hosts are not re-fetched in the test.
- [x] Monitor only organisations whose plan flag allows it (trial or Protect). Done when: a free organisation is skipped.
- [x] Call `wakeGlimmer` (D03 T04 §15) in the run's Workflow (**Corrected 2026-11-01**, completion review gap 9: was "at the start, before candidate resolution, so the warm-up overlaps the DNS checks"; it is now woken after the lookups and before the first capture, only when there are pages to capture, for at most `SCREEN_CALLS_PER_RUN` pages, so the warm-up overlaps the captures and the reservation fits the shared daily cap, where every candidate as a call asked for 100 minutes), and screen no page on Glimmer until it answers (added 2026-10-28, operator decision on the tuned Glimmer deployment). Done when: `test/monitor/cron.test.ts` shows the wake request before the first DNS lookup.
- [x] Run the daily monitor only for organisations with `monitor` (`hasFeature`, D07 T02 §8). Done when: a lapsed organisation's run makes no DNS or browser request, an entitled one's runs, and removing the check fails the test. Source: D07 T02 §8 plan review.
- [x] Capture new, DNS-changed, week-old and previously failed resolving hosts into R2 for §3, retry a failed capture the next run, and settle Glimmer's reservation at the run's end (corrections 7 to 10). Done when: `test/monitor/cron.test.ts` shows a host whose page becomes a lure behind identical DNS captured again after 7 days, a failed first capture followed by a successful one after a Workflow restart, readable capture artefacts under the organisation's prefix, an unchanged host reusing its capture, and `settleGlimmer` called with zero when nothing was captured.
- [x] Dispatch, recheck eligibility and log every run (corrections 11 to 13). Done when: `test/monitor/cron.test.ts` drives the scheduled branch for three organisations (one creation failing, the others run), a repeated tick the same day and the next day, the three existing crons unchanged, an organisation with protection switched off or its last verified domain removed making no wake, DNS or browser request, and each run's `monitor_runs` row with its outcome and counts, a lookup failure kept apart from not resolving.
- [x] Commit: `monitor: daily run with DNS liveness and change tracking`

**Test checkpoint:** `pnpm exec vitest run test/monitor/cron.test.ts` passes.

> **Verified:** 2026-11-01 | §2 | 723ae8cd34959b34e54086461195423468dea242
> **Review:** `docs/reviews/d05-t04-s2.json`

## 3. Screening new or changed live pages

Each fetched page's screenshot and visible text go to `screenPage` with the screener D03 T04 §1 names (the heading once named a `MONITOR_SCREENER` setting that does not exist; routing is fixed, correction 15; D03 T04 §1: Loupe on Fireworks, Muse Spark when it is warming, out of minutes or failing; corrected 2026-10-28 20:45 SAST: Loupe replaces base Glimmer; corrected 2026-10-28, operator decision; corrected 2026-10-27: was D03 T04 §2 with a later switch to Glimmer, removed); only pages judged as lures go further (spec 4.11).

> **Started:** 2026-11-01T01:30Z

**Corrected 2026-11-01** (at start, checked against `src/vision/screen.ts` and `page-screen.ts` (D03 T04 §1), `src/monitor/run.ts` (§2), `src/meta/structured.ts` and the code): (1) screening is driven by what is owed, not by what was captured in this attempt: a host is owed a screening while its current capture (`capture_key`) has no row in a new `monitor_screens` table, so a run stopped after the captures, or a Workflow retry, screens exactly the pages still missing and never one twice (the lesson of §2's gap 5); the page's screenshot and text are read back from R2 by `capture_key`; (2) `monitor_screens` (migration 0066, to be confirmed by the coordinator) holds one row per capture: org, domain, `capture_key`, the verdict (`lure`, `lure_type`, `brand`, `has_login_form`, `has_payment_form`, `confidence`), `screener` (`glimmer` or `spark`), `glimmer_reason`, the Spark call and log ids, and `screened_at`; the history stays for §4's findings and §5's dismissals, and `monitor_runs` gains `screened`, `parked`, `lures` and `screen_failed`; (3) `monitor_hosts.status` gains `parked` (its CHECK is rebuilt; `dismissed` is never overwritten by it, and a host whose later capture is not parked returns to `watching`), plus `screen_failures` counting failed screenings of the current capture, five at most before the page is left until its next capture; (4) a page is parked, and screened by no model, only when it shows no sign of a form: its text names no credential or payment word (password, sign in, log in, card, CVV, pay, account number, bank) and either carries a known parking or for-sale marker (Sedo, Afternic, HugeDomains, Dan.com, ParkingCrew, Bodis, "this domain is for sale", "buy this domain", and the registrars' own parked-page wording) in under 2,000 characters, or is empty (under 40 visible characters with a screenshot under 10 KB); a lure that says "for sale" beside a login form, or hides its words in an image, is therefore still screened, and the rules are tested against exactly those evasions; (5) the run opens one Loupe session (`sessionFrom` over the wake's answer, a small additive export in `src/vision/screen.ts` that `openGlimmer` now uses, since `openGlimmer` drops the failed-settlement burst D03 T04 §40 returns; the coordinator is told), screens at most 50 pages a run (§2's capture limit), the first 15 on Loupe inside its reservation and the rest on Spark, which the shared meta budget caps and refuses by name; a page neither screener could answer stays owed with its failure counted and named in the run row, never taken for benign; (6) the run's Glimmer settlement is to the last request this run sent, Loupe's last answer when it screened any, else the wake's own (§2's rule), through the same retried settle step; (7) the page's text goes to the model only as `buildScreenRequest` builds it, in the untrusted block with the delimiter stripped, and its host from the stored candidate, never from the page; (8) a page judged a lure is only recorded here; the finding, the full vision pipeline and the walkthrough are §4's and §5's, so `lures` in the run row is the count handed on.

**Corrected 2026-11-01** (plan review, 2 P1 and 4 P2, `docs/reviews/05-trust/D05-T04-s3.md`; supersedes corrections 2, 3 and 5 where it differs): (9) the migration is `0068_monitor_screens.sql` (the coordinator's number; `monitor_hosts` is rebuilt first, and a test keeps every row of it through the rebuild); (10) parking is decided from signals taken at capture time, not from text alone: `browserCapture` counts the page's `input` elements (leaving out hidden, submit, button and image types), its password inputs, `form` elements and `iframe`s and returns them as `signals`, stored beside the screenshot and text in R2 as `signals.json`; a page is parked only when its signals are present and show no input, no form and no frame, and its text names no form word, and it is not image-led (under 400 characters of text beside a screenshot of 100 KB or more is ambiguous and screened); a capture with no readable signals (one made before this section) is screened; the tests cover a sale-marker page whose only form is a placeholder-only password field, one whose labels are an image, and one with an iframe; (11) a parked page has its own terminal record: `monitor_screens.outcome` is `screened` or `parked`, a parked row has no screener and no verdict (a CHECK ties each outcome to its columns) and a `parked_reason`, and a capture is owed while it has no row of either kind; tests show a rerun skipping a parked capture and a replacement capture becoming owed again; (12) failure recovery has its transitions tested: `screen_failures` rises with each failed attempt (a screener that could not answer, or an R2 object missing or unreadable, named), resets to 0 when a new capture replaces the old, stops the page at five, and never stops the other pages; any screening failure this run, and any owed page left over (past the 50 a run, or at the failure limit, counted as `screen_deferred`), makes the run `partial`; (13) the Loupe wake is sized by the screening workload, the hosts to capture together with the owed backlog, `min(workload, 15)` calls, and happens before the first capture whether or not anything new is captured; nothing owed and nothing to capture wakes nothing; tests cover a retry with zero new captures and outstanding screenshots, a mixed backlog, and an empty run; (14) the Glimmer session is `openGlimmer` and `closeGlimmer` as they stand (D03 T04 §40: `session.unsettled` already keeps a failed wake or warm-up settlement and `closeGlimmer` settles it again to the same cutoff), so correction 5's `sessionFrom` export and any edit of `src/vision/screen.ts` are withdrawn; a failed close hands the retry step `session.unsettled`, or the burst with the cutoff `closeGlimmer` used (Loupe's last request, else the end of the reserved window), and tests through `runMonitor` with a delayed retry prove both a settlement that fails after Loupe screened pages and a warm-up that ends in a final answer whose settlement fails; (15) there is no `MONITOR_SCREENER` setting: routing is fixed, Loupe first and Spark after, as `screenPage` does (D03 T04 §1), and the heading's mention of the setting is corrected here.

**Corrected 2026-11-01** (as built): (16) `Capture.signals` is `Signals | null`: the page's counts live in `src/monitor/signals.ts`, a module with no Worker imports so Chromium can run the expression over real pages (`test/node/monitor-signals-browser.test.ts`), and an expression that fails or answers anything but four whole counts is no signals, which screens the page rather than reading zeros that could park it; (17) `monitorDeps` takes an optional `sparkFetch` beside the Loupe `fetcher`, since the Meta client keeps its own transport and a test cannot reach it any other way; production never sets it; (18) the shared test world is `test/monitor/world.ts`, and a screener that throws (the request builder refuses a screenshot that is not a whole JPEG) is that page's named failure, never the run's.

**Corrected 2026-11-01** (completion review, `docs/reviews/05-trust/D05-T04-s3.md`, G1 and G3): (19) the page signals count through shadow roots (G1): `SHADOW_HOOK` runs before the page's scripts (`evaluateOnNewDocument`) and keeps every shadow root a script attaches, closed ones included, `SIGNALS` counts through the document and every root kept or open, and `components` counts custom elements besides, since a root made before the hook or by another route can still hide a field, so any component means a page is never parked; a stored `signals.json` without `components` reads as no signals and is screened; (20) the owed backlog is screened before the capture batch (G3), while the session is warm, leaving a host about to be captured again (its old page is never worth a call); the pages the run captures are screened after, with what is left of the 50 a run, and a page tried once in a run is not tried again in it; the first result then does not wait for the batch (measured on the test world's clock with 49 slow hosts: the first result at +0 ms, the batch taking 1,470 s, `docs/frontier-log.md`).

**Corrected 2026-11-01** (round 1, P1; supersedes correction 19's hook): (21) the page's counts are read from the browser's own document tree over the protocol (`DOM.getDocument` with `pierce`, through the capture's existing CDP session), never from script run in the page, since any in-page hook or counter can be blinded by the page (it can empty the kept array, patch `querySelectorAll`, `slice` and `attachShadow`, or attach its root through another frame's pristine function); the tree holds every shadow root a script attached, closed ones too, and the frames' documents, the browser's own user-agent roots are left out, and a tree past 50,000 nodes is no signals and is screened; components, and the rest of correction 19 and 20, stand.

**Corrected 2026-11-01** (round 2, P1): (22) a text area and a menu count as input whatever `type` their markup claims, since only an `input`'s type decides whether it takes typing, and an element made editable (`contenteditable`, any value but `false`) counts too; the known limit that remains is a page that takes typing with no element at all (a form drawn on a canvas with key listeners), which no tree can show: only the image-led rule and the marker and length rules stand between such a page and parking, and that is the cost of skipping the model for parked pages, which the section's contract asks for.

**Corrected 2026-11-01** (round 3, P1; refines 21): (23) the capture gathers its evidence in an order no page script can blind: the structure is read twice over the protocol, either side of the screenshot, a field counted if it was there at either moment; the parking text comes from that same tree (text nodes in document order, without scripts, styles or the head, capped) and is kept in `signals.json` beside the counts, and parking reads only that; the page's own `innerText`, which runs a getter the page may have redefined (one can delete the form the moment it is read), is read last and goes only to the model; a capture whose file lacks the tree's text, or whose tree could not be read, is screened.

**Corrected 2026-11-01** (round 4, P1; refines 23): (24) the parking text is the text the browser renders, taken from its accessibility tree (`Accessibility.getFullAXTree`, which leaves out `display:none`, the `hidden` attribute, `visibility:hidden` and `aria-hidden`), not every text node of the document, and the signals carry `hidden`, the characters of text in the document that the browser does not render; a page that hides more than 500 characters is screened, since hidden padding or a hidden marker is how the rules were being fooled (the padding made an image-led page's text long; the hidden words matched a marker), and a closed cookie notice or a menu's options hide a few and still park; a capture whose accessibility tree could not be read is screened. The limit stated in (22) and (23) stands, widened: text that is rendered but cannot be seen (transparent, off-screen, tiny, low contrast) and a page that shows the monitor a different face from its visitors (cloaking) defeat any screener, so parking is the cost optimisation the section's contract asks for, not a guarantee.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Screen pages with `screenPage`. Done when: a stubbed lure page is flagged and a parked-domain page is not.

- [x] Add migration `0068_monitor_screens.sql`: first rebuild `monitor_hosts` with `status` allowing `parked` and a `screen_failures` count, then create `monitor_screens` (org, domain, `capture_key`, `outcome` of `screened` or `parked`, the verdict, `screener`, `glimmer_reason`, the Spark call and log ids, `parked_reason`, `screened_at`, with the CHECK of correction 11) and add `monitor_runs.screened`, `parked`, `lures`, `screen_failed` and `screen_deferred`. Done when: `test/monitor/screen.test.ts` shows the rebuild keeping every `monitor_hosts` row, a `parked` status accepted and a made-up one refused, each outcome's columns enforced, and every column read back.
- [x] Make `browserCapture` count the page's inputs, password inputs, forms and iframes (correction 10) and store them as `signals.json` beside the screenshot and text. Done when: the browser-capture test shows the counts for a page with a placeholder-only password field, an iframe, and no form, and the object stored.
- [x] Write the parking rules in `src/monitor/parked.ts` over the text, the signals and the screenshot size (correction 10). Done when: `test/monitor/screen.test.ts` parks a Sedo page, an Afternic page, a registrar's page and an empty page, and screens a sale page with a placeholder-only password field, one with image labels, one with an iframe, a long page that mentions a sale, an image-led page and a capture with no signals.
- [x] Write `screenOwed` in `src/monitor/screen.ts`: pick the hosts whose current capture has no `monitor_screens` row (oldest first, at most 50), read their screenshot, text and signals back from R2, park or screen each through `screenPage` (Loupe first, Spark after), and write the row, or count the failure (corrections 11 and 12). Done when: the tests flag a stubbed lure and not a benign page, record `screener`, `glimmer_reason` and the Spark ids, write nothing twice on a rerun, skip a parked capture until a replacement arrives, stop a page at five failures and restart it on a new capture, and name a missing R2 object.
- [x] Open the run's one Loupe session with `openGlimmer` sized by the workload before the first capture and close it with `closeGlimmer` after screening, handing the retry step what `session.unsettled` or the close's cutoff says (corrections 13 and 14), and count `screened`, `parked`, `lures`, `screen_failed` and `screen_deferred`, the run `partial` on any failure or leftover. Done when: the monitor tests show a retry with zero new captures screening the outstanding pages, a mixed backlog, an empty run waking nothing, and both failed-settlement paths (**Corrected 2026-11-01:** was "through `runMonitor`"; they run through `monitorOrg` on the real ledger and the settle step's `settleAgain` three hours late, and `runMonitor`'s own retry is proven by §2's round 3 test) settled to the right cutoff.
- [x] Give the Workflow's `monitorDeps` a Spark context (the budget over D1, its record writes awaited before the step ends). Done when: a test through `monitorDeps` with a stubbed Meta transport screens a page on Spark when Loupe is down and writes the call's budget record.
- [x] Put the page's text through `buildScreenRequest` only, with the host from the stored candidate (correction 7). Done when: a page whose text contains the untrusted block's delimiter and an instruction to answer "not a lure" is screened with the delimiter stripped and the request carrying the host the monitor holds.
- [x] Commit: `monitor: screening of new or changed pages`

**Test checkpoint:** `pnpm exec vitest run test/monitor/screen.test.ts test/monitor/cron.test.ts` passes, and fails if a lure is left unscreened, a form behind a "for sale" line is parked, or a run is screened twice.

> **Verified:** 2026-11-01 | §3 | a3b714ed094d96ee8ad7d23e21fc56002a0e3f7e
> **Review:** `docs/reviews/d05-t04-s3.json`

## 4. Full pipeline on

Flagged pages get the full treatment (spec 4.11): screenshot, SAM logo crop compared with the business's registered logo, Muse Spark reading, and the walkthrough when a login or payment form is present.

> **Started:** 2026-11-02T20:05Z

**Corrected 2026-11-02** (at start, checked against the tree): (1) a monitor case needs `channel = 'monitor'`, which neither the `Channel` enum (`src/db/cases.ts`) nor the `cases` table CHECK (migration 0001) allows today; a new migration (number asked from the coordinator 2026-11-02) rebuilds the CHECK and the enum gains the value, with the email/upload refinements in `createCase` scoped to their channels. (2) The work itself is `monitorPipeline` in `src/monitor/pipeline.ts`: for each page from `flaggedForWalkthrough` (§9's settled selection, never §10's labelled findings) it creates the monitor case, stores the page's capture as the case's page artefacts, then runs `visionStep` (whose logo comparison already reads the registered logo reference, `src/vision/logo-reference.ts`, not a brand table, so item 2 is the step's own proof on a monitor case) and, where the vision read finds a login or payment form, `walkthroughStep` under its own driver limits. (3) Mail-only checks never run: the pipeline calls the two steps directly, it does not start the mail Workflow. (4) Spend: Spark and walkthrough calls settle in the live D1 ledger under their callers; this section's proof is stubbed, and any live run states its own cap in the lane outbox before the call and never raises it.

**Phase:** 7
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Run the case pipeline on a flagged page as a monitor case. Done when: a flagged fixture page yields logo, reading and walkthrough evidence.

- [x] Create a case with `channel = "monitor"` for each flagged page and run the vision and walkthrough steps (skipping mail-only checks). Done when: `test/monitor/pipeline.test.ts` passes with stubs. Done 2026-11-02 with the coordinator's safe shape (no channel change, no cases rebuild): the case is an upload by the system uploader and the monitor origin is the `monitor_investigations` row (migration 0084).
- [x] Read the monitor page through its own input path (plan review gap 1): `monitorPipeline` builds the reading image from the stored capture (screenshot, final URL, visible text) and calls `readMail` in `src/vision/reading.ts` directly, never `visionStep` (which renders mail), writing `readingItems` through the vision producer. Done when: the stubbed test reads the evidence back tied to the capture key.
- [x] Compare logo crops with the registered logo (not the brand table) for monitor cases. Done when: the fixture's logo match is recorded.
- [x] Resolve the registered logo by organisation (plan review gap 2): the reference is the protected business's own `identities.logo_r2_key` bytes (missing, removed, unreadable and SVG states each stated, never a match), compared with `compareLogo`; two organisations sharing a trading name use their own references and no registered detail reaches checker-visible evidence. Done when: the stubbed test proves both organisations and each logo state.
- [x] Bridge to the walkthrough (plan review gap 3): when the reading reports a login or payment form, the pipeline writes the `link.credential_form` or `link.card_form` evidence (with `detail.page`) that `walkTarget` requires, then calls `walkthroughStep` under its driver limits; no form, no walk. Done when: the stubbed test invokes the driver for each form kind, never without a trigger, inside the containment limits.
- [x] Wire it into the day (plan review gap 4): `MonitorWorkflow` invokes the pipeline after screening and second-look settlement for the run's accepted flags. Done when: a Workflow-level stubbed test shows an accepted flag investigated and a declined one not.
- [x] Persist the investigation (plan review gap 5): the §4 migration also creates `monitor_investigations` (organisation, capture key, case id, state, updated at), one row per settled capture; outstanding means no row or a non-terminal state, independent of the run's date. Done when: interruption after case creation, restart after evidence, a repeated run and a changed capture each resume or re-investigate correctly in the test.
- [x] Settle the finding (plan review gap 6): each investigation ends confirmed, unconfirmed or partial with its evidence references stored on the row, for §5 to read; one failed page never stops later pages. Done when: the test reads each outcome back, including budget refusal, model failure and a missing artefact.
- [x] Commit: `monitor: full pipeline on flagged pages`

**Test checkpoint:** `pnpm exec vitest run test/monitor/pipeline.test.ts` passes.

> **Verified:** 2026-11-02 | §4 | bbe69251eb5833947aa0cd0c3089da7cb7499fe4
> **Review:** `docs/reviews/d05-t04-s4.json`

## 5. Monitor alerts and takedown pack

The business gets an alert with the evidence and a takedown pack: domain, registrar and hosting provider from RDAP, screenshots, abuse contacts (spec 4.11). We never contact registrars or hosts for them during the event. Findings are listed on the console, where the business can dismiss one.

> **Started:** 2026-11-02T21:00Z

**Corrected 2026-11-02** (at start, checked against the tree): (1) a finding is a settled `monitor_investigations` row (§4); its lifecycle (new, watching, taken offline, dismissed, with its alert and dismiss records) lives in a new `monitor_findings` table in migration 0086 (0085 is the checks lane's in the ledger, so 0086 was asked from the coordinator 2026-11-02 and used provisionally as the next free number; 0084's investigations table is never rebuilt either). (2) The alert goes to the identity's alert address (`src/trust/identity.ts`, the contact alerts already read), once per finding, keyed on the findings row's `alerted_at`, so a second run sends nothing. (3) RDAP facts come from the repository's own RDAP code (`src/checks/rdap*`): registrar and abuse contact for the domain, the hosting network and its abuse contact for a resolved IP; a lookup that fails states itself in the pack, never a guessed contact. (4) The pack is Markdown plus a PDF rendered from the same content (the repository's PDF writer), with the settled capture's screenshot embedded in the PDF and named in the Markdown; it is built for the member to send, and nothing in it is sent by us.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, impersonation monitor section
**Job:** a business owner learns a fake site exists and has what they need to get it taken down
**Treatment:** the finding first, the takedown steps second, nothing sent on their behalf
**Chrome:** `AppShell`, `EvidenceCard`, `Button`, `EmptyState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the takedown pack. Done when: a finding has a downloadable pack with RDAP facts and screenshots.
2. Alert and list. Done when: the alias receives the alert and the console lists the finding with dismiss.

- [x] Write `takedownPack(finding)` building a Markdown and PDF pack (domain, registrar, abuse contact, hosting network and abuse contact from RDAP for the IP, first seen, screenshots, evidence summaries). Done when: `test/monitor/takedown.test.ts` checks every field for a fixture.
- [x] Build the production contacts lookup (plan review gap 6): `rdapContacts` in `src/monitor/rdap-contacts.ts` parses the domain RDAP response (registrar entity, its abuse email) and the IP RDAP response (network name, its abuse email) with bounded fetches; an unavailable or contactless answer states itself, never a guessed contact. Done when: `test/monitor/takedown.test.ts` parses fixture RDAP for both, including the no-abuse-contact case.
- [x] Render the pack PDF in production (gaps 6 and 7): the PDF is generated by code from the same pack content with the settled screenshot embedded, served with its Markdown twin at download endpoints with content types and filenames; a missing or expired capture artefact states itself in both. Done when: the test opens the generated PDF, reads its text and image back, and downloads both formats through the member route.
- [x] Create findings from settled investigations (gaps 1, 2 and 3): `findingsFromInvestigations` in `src/monitor/findings.ts` runs in the MonitorWorkflow after the pipeline step; a finding's identity is the organisation and host (across captures, so a dismissal survives a changed capture), only a `confirmed` investigation alerts as a fake site, `unconfirmed` lists without an impersonation claim, and `partial` lists as incomplete. A dismissed host reopens only on a new confirmed capture after the dismissal; Taken offline follows a later capture that no longer resolves or no longer flags. Dismissal can be restored from the list. Done when: `test/monitor/findings.test.ts` proves each outcome, transition and restore.
- [x] Send one alert per new finding with `sendMail({ kind: "alert" })` to the identity's alert address. Done when: a second run on the same finding sends nothing.
- [x] Deliver the alert safely (gaps 4 and 10): the send uses the stable key `monitor-finding:<org>:<host>`; `alerted_at` is written only on a confirmed send, a definite failure retries on the next run, an uncertain outcome is surfaced on the finding, and an allowlist refusal is stated, never resent. The alert body carries the finding facts, the screenshot, the pack download button and a plain link to the console finding. Done when: the test asserts the first delivery, the refusal, and a restart after delivery before the findings update.
- [x] Build the console findings list (`src/web/pages/monitor.tsx`) with status, first seen, pack download and dismiss (with reason). Done when: the page test dismisses a finding and it stays dismissed on the next run. Cheaper substitute: alert mail only.
- [x] Complete the surface contract (gaps 5, 8 and 9): organisation-scoped routes for the list, both downloads and dismiss/restore with request validation; the selected finding's evidence panel; summary counts and last/next run read from real data (including `memberShell`'s `monitorNew`); empty (no findings, not yet monitored), partial-run and E5 error states; dismiss validation, cancel, pending, failure and recovery states; phone layout and keyboard access. Done when: `test/web/monitor-page.test.ts` proves tenant isolation on every endpoint, unauthenticated refusal, each state, and the counts after dismissal.
- [x] Commit: `monitor: alerts, takedown pack and findings list`

**Test checkpoint:** `pnpm exec vitest run test/monitor/takedown.test.ts test/web/monitor-page.test.ts` passes.

> **Verified:** 2026-11-03 | §5 | 53fc4baff037a8110c0652e33dbcf0a84dfd0482
> **Review:** `docs/reviews/d05-t04-s5.json`

## 6. Demo lookalike site found by

The demo needs the monitor to find a real live page: a lookalike of the fictional demo business, hosted by us on a fixture domain under `fixtures.isitlegit.co.za`, wired into the demo business's candidate list as an extra seed so the daily run finds it (spec 4.11, plan "Demo fixture").

**Phase:** 7
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Host the lookalike and seed it. Done when: running the monitor for the demo business finds it and sends the alert.

- [ ] Host `fixtures/fynbos-lookalike/` (fictional Fynbos Freight login copy) on the fixtures host with `noindex`. Done when: the page answers.
- [ ] Add `monitor_seeds` for demo businesses only, so the fixture host is checked with the candidates. Done when: the seed table exists and is used only for organisations flagged `demo`.
- [ ] Run the monitor for the demo business and record the alert time in `docs/live-checks.md`. Done when: the entry exists.
- [ ] Commit: `monitor: demo lookalike found by the daily run`

**Test checkpoint:** `pnpm exec tsx scripts/run-monitor.ts --org demo-fynbos --wait 300` exits 0 after a finding for the fixture host is stored.

## 7. Certificate-transparency search for

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

> **Started:** 2026-11-01T04:04Z

**Corrected 2026-11-01** (at start, checked against `src/monitor/run.ts` as §2 and §3 built it, `monitor_screens` (§3) and the stamped §2's own corrections): (1) screening an unchanged page again says nothing unless the page is fetched again, so a daily re-screen is a daily re-capture and screening of every live candidate: `choose` in `src/monitor/run.ts` makes a host due when it resolves, was captured successfully and its last capture is a day old or more (an hour's grace for a run a little earlier than the day before), and this replaces §2's correction 7 and 8, the weekly refresh, which narrowed the operator's decision of 2026-10-28 22:42 on cost alone before this section was built; `REFRESH_DAYS` and `MAX_REFRESHES` and the spreading of refreshes over the week go, and §2's two tests of it are replaced by this section's; (2) the day's order under the 50 captures a run (the cap stays, and with it the browser and Loupe bound): new and changed pages first (a host with no capture, or DNS that changed since its last good capture), then hosts whose capture failed and is retried, then the unchanged ones oldest capture first, so a day cut short by the cap or by Loupe's minutes screens the likeliest flips first and every unchanged page gets its turn in order; whatever the cap leaves is counted as deferred and makes the run partial, as before; (3) a parked page is still fetched each day, which is what shows it flipping, and is still skipped by the models: its new capture is parked again by §3's rules or, having changed into a page those rules do not park, screened; (4) the history is `monitor_screens` as §3 built it, one row per capture with its day (`screened_at`), screener and verdict, so a flip shows as a benign row and then a lure row with no new column; (5) Loupe's reservation and the Spark caps are unchanged: pages past Loupe's minutes go to Spark under the Meta budget, which refuses by name, and a page neither answers stays owed with its failure counted (§3).

**Corrected 2026-11-01** (plan review, 1 P1 and 3 P2, `docs/reviews/05-trust/D05-T04-s8.md`; supersedes corrections 1 and 2 where it differs): (6) the coverage promise is reconciled with the 50-capture cap, which stays (a Workflow step runs 30 minutes and a capture can take 20 seconds): every live host is captured and screened daily while at most 50 are due, and above that its wait is bounded, never indefinite: the day's 50 slots are shared, at most 30 for new, changed and retried hosts (oldest capture first among them, never-captured first) and at least 20 held for the unchanged ones, each class lending its unused slots to the other, so sustained DNS churn on any number of hosts cannot starve the unchanged ones, which are reached within `ceil(due / 20)` days at worst and `ceil(due / 50)` with no churn; the section says so rather than promising a daily visit to more hosts than a day holds, and a host left over is counted as deferred and makes the run partial; (7) screening priority follows capture priority (a lure that changed today must not wait behind a backlog): the owed backlog gets at most 25 of the day's 50 screenings before the captures, the pages this run captured are screened next in capture order (new and changed first), and any backlog left after that gets what remains; (8) a host that has failed its capture five times on the same address is probed once a day after its last attempt, with a success resetting its count, so a site back from an HTTP outage on unchanged DNS is seen again; while any live host is at the limit the run says so (`capture:blocked`, named in the run row's errors, the run partial), never complete; (9) every test of §2 that encoded the weekly refresh is migrated to this contract, not deleted: the lone-capture refresh becomes the daily one, the sustained-churn test becomes the shared slots, the overdue-accounting-after-an-outage test becomes the bounded catch-up, and the weekly cohort test becomes the bounded wait with more than 50 live hosts; the tests of §3 that assumed an unchanged page is left alone the next day are migrated with them.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Re-screen every live candidate daily. Done when: an unchanged live page is screened again on the next day's run, and a page that flipped to a lure is flagged that day.

- [x] In `choose` (`src/monitor/run.ts`), make every live host with a good capture a day old or more due again, the weekly refresh and its constants removed (correction 1), and replace §2's two tests of the weekly refresh. Done when: `test/monitor/rescreen.test.ts` shows an unchanged live page captured and screened again on day two and again on day three, a page not yet a day old left alone, and the old weekly tests gone.
- [x] Order the day's captures new and changed first, then retries, then unchanged ones oldest first, under the unchanged 50-a-run cap (correction 2). Done when: the test's capped day, with more live hosts than the cap, captures the new page, the changed one and the longest-unscreened ones and not the most recently screened, counts the rest as deferred, and over a few days screens every unchanged host in turn.
- [x] Keep a parked page fetched each day and skipped by the models (correction 3). Done when: the test shows a parked page re-captured on day two with no model call and its host still parked, and the same page, flipped to a lure the next day, screened and flagged that day.
- [x] Read the history from `monitor_screens` (correction 4). Done when: the test reads day one's benign row and day two's lure row for the flipped fixture, each with its day and screener.
- [x] Share the 50 slots between new, changed and retried hosts (30 at most, oldest capture first, never-captured first) and the unchanged ones (20 at least), each lending unused slots to the other (correction 6). Done when: `test/monitor/rescreen.test.ts` shows 120 new hosts all captured within `ceil(120 / 30)` days and then each seen at least every `ceil(120 / 50)` days, and 100 unchanged hosts plus 50 whose DNS changes every day all reached within `ceil(100 / 20)` days with the churning ones still captured every day.
- [x] Give the backlog at most 25 screenings before the captures, screen the pages this run captured next in capture order, then any backlog left (correction 7). Done when: the test's full backlog of 40 owed pages plus a newly changed lure screens and flags the lure in the same run, and the backlog finishes on the following days.
- [x] Probe a host at the capture-failure limit once a day after its last attempt, and report the run partial with `capture:blocked` while any live host is at the limit (correction 8). Done when: the test brings a host back from five failures on unchanged DNS, and shows a still-blocked host named in the run row's errors.
- [x] Migrate `test/monitor/cron.test.ts`'s four weekly-refresh tests and `test/monitor/screen.test.ts`'s day-two assumptions to the corrected contract (correction 9). Done when: no test mentions a week's refresh, each of the starvation, outage and accounting guarantees has its test, and the whole monitor suite passes.
- [x] Commit: `monitor: re-screen every live candidate daily`

**Test checkpoint:** `pnpm exec vitest run test/monitor/rescreen.test.ts test/monitor/cron.test.ts test/monitor/screen.test.ts` passes, and fails if an unchanged live page is skipped, a parked one is screened, or a new page waits behind unchanged ones.

> **Verified:** 2026-11-01 | §8 | b04dd7f10b63edd61333b8ee1dd863cca158f1a1
> **Review:** `docs/reviews/d05-t04-s8.json`

## 9. Spark second look before walkthrough

A page Loupe flags goes to the full pipeline (§4), whose Muse Wonder walkthrough is the costliest step. A Muse Spark second look on the flagged page's screenshot and text, a few cents, confirms the flag before the walkthrough runs, so a false flag costs a Spark call instead of a walkthrough (operator decision 2026-10-28 22:42 SAST; spec 4.11). A page Spark already screened (Loupe was warming or out of minutes) needs no second look.

> **Started:** 2026-11-01T04:35Z

**Corrected 2026-11-01** (at start, checked against `src/monitor/screen.ts` (§3), `src/vision/screen.ts` and `screen-request.ts` (D03 T04 §1), `src/meta/structured.ts` and `src/monitor/workflow.ts`): (1) §4 is not built, so "between §3 and §4" is the screening pass itself: `screenOwed` asks for the second look in the same pass, straight after a Loupe verdict that flags the page, and §4 reads the store: this section builds `flaggedForWalkthrough(db, orgId, since)` in `src/monitor/flagged.ts`, the one query §4 takes its pages from (a lure whose second look is not `declined`), so a declined flag cannot reach §4 by any other path; (2) the second look is one Spark call through `structured` with the screener's own request (`sparkRequest(buildScreenRequest(...))`, so the screenshot and the untrusted block are built in one place), owned by `{ kind: "monitor", run, host, step: "second-look" }` and under the monitor's Meta budget; it is the same call the screener makes when Loupe cannot answer, so `secondLook` shares that request and does not copy it; (3) the verdict is stored on the page's `monitor_screens` row (migration 0072, renumbered by the coordinator from 0069 at the merge): `second_look` (`confirmed`, `declined` or `unavailable`) and Spark's call and log ids, both verdicts kept (Loupe's in the existing columns, Spark's `lure` and `lure_type` in `second_look_lure` and `second_look_type`); a page Spark screened itself has `second_look` null and is asked nothing; (4) a second look that cannot answer (budget refused, a schema failure, a Meta outage) is `unavailable` and the flag stands: a flagged page is never taken for benign by an outage, and the run counts it as `second_look_unavailable` and is partial; (5) a declined flag leaves the standing count: the run's `lures` counts the flags that stand (confirmed or unavailable) and a new run count `lures_declined` the others, and the host stays `watching`; (6) the training example is the declined row itself: `second_look = 'declined'` is the filter §10's export reads, with the screenshot and text still in R2 under the row's `capture_key`; (7) the section does not widen the daily cap: a second look is one extra call for a page that was flagged, bounded by the 50 screenings a run and the Spark budget.

**Corrected 2026-11-01** (plan review, 4 P2, `docs/reviews/05-trust/D05-T04-s9.md`; supersedes corrections 5 and 7 where it differs): (8) the run's two new counts are read back from the store when the run ends, not counted in memory, so a Workflow retry after a stored verdict reports them again: `lures_declined` and `second_look_unavailable` are the number of `monitor_screens` rows of the organisation, screened on the run's South African day, with that `second_look`; a run that stored an unavailable second look and was retried finishes partial, and the retry never repeats a second look already stored (the row exists, so the page is not owed); (9) `flaggedForWalkthrough(db, orgId, since)` returns the organisation's current-capture lures screened at or after `since` whose `second_look` is `confirmed`, `unavailable` or null: a lure Spark screened itself has no second look and goes to §4, and so does a Loupe flag stored before this migration (conservative: a flag is never dropped for want of a second look); its test pins the organisation and the `since` boundaries; (10) the unavailable path is proved through the real adapters, not a stub that returns `unavailable`: `monitorDeps` with the stand-in transport and the real budget, for a refused budget, an invalid answer after its repair and a transport failure, each read back as a stored `unavailable` row that keeps the flag, a partial run, and later pages still screened; (11) "one extra call" means one logical second look, one `structured` call: the shared contract may repair an invalid answer once and the client may retry a transient failure, and every attempt is billed to the monitor's Meta budget, which is the bound; the test shows the repair and an exhausted budget stopping at the budget, with no attempt beyond it.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Confirm a Loupe flag with Spark before §4 runs. Done when: a page Spark does not confirm stops before the walkthrough, and a confirmed one goes on.

- [x] Add migration `src/db/migrations/0072_monitor_second_look.sql`: `second_look`, `second_look_lure`, `second_look_type`, `second_look_call_id` and `second_look_log_id` on `monitor_screens`, `lures_declined` and `second_look_unavailable` on `monitor_runs`, and a partial index on `second_look = 'declined'` (correction 3). Done when: `test/monitor/second-look.test.ts` creates the columns, refuses a made-up `second_look`, and the index serves the declined query.
- [x] Write `secondLook(page, run, spark)` in `src/monitor/second-look.ts` asking `muse-spark-1.3` through `structured` with the screener's request on the flagged page's screenshot and text in an untrusted block (corrections 2 and 3). Done when: `test/monitor/second-look.test.ts` confirms a lure fixture and declines a benign one with a stubbed transport, and the request carries the host the monitor holds and the stripped text. Cheaper substitute: walking every flagged page.
- [x] Call it from `screenOwed` (`src/monitor/screen.ts`) for a page Loupe flagged, skipping a page Spark screened, and record both verdicts (corrections 1, 4 and 5). Done when: the test shows a declined flag stored as declined and not counted in `lures`, a Spark-screened page not asked twice, and an unavailable second look keeping the flag.
- [x] Wire the Spark context into `monitorDeps` (`src/monitor/workflow.ts`) and add `lures_declined` and `second_look_unavailable` to the run row (`src/monitor/run.ts`). Done when: the real Spark path through the stand-in transport writes the call's record under the `second-look` step, and a refused budget, an invalid answer after its repair and a transport failure each become a stored `unavailable` row, a partial run and later pages still screened, with the repair and exhausted budget stopping at the budget (corrections 10 and 11); the two run counts are read back from the store, and a retried run after a stored `unavailable` reports it again and repeats no second look (correction 8).
- [x] Write `flaggedForWalkthrough(db, orgId, since)` in `src/monitor/flagged.ts` (correction 1) and keep a declined flag as a training example (correction 6). Done when: the test shows a declined flag never returned to §4, a confirmed and an unavailable one returned, and the declined candidate carrying `second_look = declined` for §10; a Spark-screened lure with a null `second_look` returned, another organisation's lure and one screened before `since` not (corrections 9).
- [x] Commit: `monitor: Spark second look before the walkthrough`

**Test checkpoint:** `pnpm exec vitest run test/monitor/second-look.test.ts test/monitor/screen.test.ts test/monitor/cron.test.ts` passes, and fails if a declined flag reaches the walkthrough or a Spark-screened page is asked twice.

> **Verified:** 2026-11-01 | §9 | c02c5dadd2752744ee21b1eafbe0cd927a813a32
> **Review:** `docs/reviews/d05-t04-s9.json`

## 10. Findings exported to

> **Started:** 2026-11-02T23:25Z

Loupe gets better on real South African lures only if what the monitor learns flows back into its training set (operator decision 2026-10-28 22:42 SAST: Loupe's learning is "extremely important"). Each labelled outcome becomes a training page: a lure the full pipeline confirmed, a flag Spark declined (§9), and a finding the business dismissed as not a fake (§5). Production deletes stored artefacts after 30 days (spec 4.8), and this machine may be off for days, so a labelled finding's public page is copied in production the moment it is labelled, into R2 under `training/`, and a local export copies it into Loupe's training store (operator question 2026-10-28 22:51 SAST: how production data reaches the store). **Operator decision (2026-10-28 22:56 SAST):** no retention is set on `training/`: no lifecycle rule and no deletion, so the R2 copies stay as the durable record of every monitor-labelled page, and the local store can be rebuilt from them. The store lives outside every repository at `~/isitlegit-data/glimmer` (`GLIMMER_DATA_DIR` moves it; `storeDir()` in `scripts/glimmer/store.ts`), with origin `monitor`, so the glimmer lane's retraining (D03 T04, its own section) takes them into Loupe's next version.

**Phase:** 7
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Copy each labelled finding's public page into R2 `training/` in production when it is labelled. Done when: a labelled finding's copy survives the 30-day deletion of its case artefacts.
2. Copy `training/` into the training store from this machine. Done when: a run adds each new copy to the store once, leaves R2 unchanged, and a second run adds nothing.

- [x] Write `copyForTraining(finding, label, env)` in `src/monitor/training.ts`, called where a finding gets its label (the full pipeline's confirmation in §4, a declined second look in §9, a dismissal in §5), writing the fetched page's screenshot and visible text with a `meta.json` (finding id, host, URL, fetch time, label `lure` or `benign`, why) to R2 `training/<finding id>/`, once per finding. Done when: `test/monitor/training.test.ts` sees one copy per labelled finding, none for an unlabelled one, and the copy kept after the case's artefacts are deleted; no lifecycle rule covers `training/` (`wrangler r2 bucket lifecycle list` names none for it). Cheaper substitute: exporting from the case's own artefacts, which are deleted after 30 days.
- [ ] Disclose the copy: the privacy page (D07 T06) states that public lookalike pages the monitor finds are kept to train Loupe, with no fixed expiry, and that a business can ask for its findings' pages to be removed. Done when: D07 T06's processors paragraph names it, with a dated note there.
- [x] Write `scripts/monitor-export.ts` listing R2 `training/` (through the Cloudflare API with the vault's R2 credentials, never printed), storing each copy with `putPage` (`scripts/glimmer/store.ts`) as origin `monitor` with its host, label and finding id, and never deleting or changing anything in R2 (no retention is set, operator 2026-10-28). Done when: `test/node/monitor-export.test.ts` stores a confirmed lure, a declined flag and a dismissed finding from a stubbed bucket with the right labels, and sends the bucket no delete or write. Cheaper substitute: copying screenshots by hand.
- [ ] Run the export daily from this machine (a user systemd timer, `infra/systemd/monitor-export.timer`) and at the start of every Loupe retraining run (the glimmer lane's runbook, `docs/glimmer/retraining.md`). Done when: `systemctl --user list-timers` shows it, and the runbook's first step names the export.
- [x] Keep the export resumable and exact: the last exported finding is recorded in the store, an interrupted run resumes after it, and a finding already stored is never stored twice. Done when: the test's interrupted run, rerun, leaves each finding stored once.
- [x] Export only the public page the daily run fetched (its screenshot and visible text, with the URL and fetch time), never a walkthrough capture taken after a form was filled or anything from a member's own account, and record in the store's manifest why each left-out item was skipped. Done when: the test exports the fetched page of a walked-through fixture, not its post-form captures, and the manifest names what was left out.
**Corrected 2026-11-02** (plan review, 9 P2, `docs/reviews/05-trust/D05-T04-s10.md`): (1) the training identity is the captured page, tenant-scoped (`<org>/<host>/<capture moment>` from the capture key), with the label's provenance (which labelling point, when, why) recorded per copy, so later captures and two organisations sharing a host never conflate. (2) The section 9 copy point is the durable second-look settlement in `screenOwed` (`src/monitor/screen.ts`), including recovery of declines settled before this section lands. (3) The exported bytes are exactly `<capture_key>screenshot.jpg` and `<capture_key>text.txt`; the capture's final URL is read from the capture's own record at copy time, never from the host row a later capture overwrote. (4) The store record follows `putPage`'s real schema (boolean lure label, an accepted `label_source`, licence, template, region and redaction fields), mapped in the export and proven by read-back; any store-schema change is the Loupe owner's. (5) A dismissal labels benign only when its reason says the site is not a fake; confirmation, dismissal and restore precedence is defined, and a restore retracts the local copy's eligibility. (6) Copying has a durable pending state and a completion marker written last, retried on later runs without changing the investigation's outcome. (7) Export resumability is per-item receipts reconciled against verified local pages, with durable skip records for what was left out. (8) The removal the privacy wording promises gets its own authorised procedure (R2, local store, reimport prevention) owned outside the read-only exporter. (9) The privacy page (site lane), the retraining runbook (Loupe owner) and the systemd timer (operator) are handoffs, not this build's items; the timer's proof is a successful export run, not its listing.

- [ ] Commit: `monitor: findings exported for Loupe's training`

**Test checkpoint:** `pnpm exec vitest run test/monitor/training.test.ts test/node/monitor-export.test.ts` passes, and fails if a finding is stored twice, mislabelled, or exported with a post-form capture.

## 11. Settled pages handed to Loupe capture

Every settled monitor page (§3 and §4's screens) and every settled case page (the vision step's read of a case's page) is handed to Loupe's capture (`captureScreenedPage` in `scripts/glimmer/store.ts`, D03 T04 §46, vision lane) so Loupe trains on pages as they were judged, not as they later became. Filed 2026-11-02 at the coordinator's routing of vision D03 T04 §46's plan review gap 2: vision builds the store, clearance, labelling, queue and admission in §46; the producers, the durable production-to-local transfer and retries are this section's.

**Phase:** 7
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Hand settled pages to the capture. Done when: a settled monitor page and a settled case page are each stored once under origin `production`.

- [ ] Write the producer in `src/monitor/training.ts` (beside §10's `copyForTraining`): when a monitor screen settles (§3, §4) or a case page's vision read settles, call the capture port with the page's screenshot, visible text, host, settle time, settling tier and both answers when escalated. Done when: `test/monitor/training.test.ts` stores each settled page once, deduplicated by screenshot hash, and nothing for an unsettled page. Cheaper substitute: §10's labelled-findings flow only, which misses unlabelled settled pages.
- [ ] Make the transfer durable: a failed capture is retried from a stored queue (the finding or case id, the artefact keys, the settle time) until it lands, and a retry never stores a page twice. Done when: the test fails the first capture, retries, and reads one stored page back.
- [ ] Keep the boundary: only the public page as fetched, never a walkthrough capture after a form was filled and never a member's own page content. Done when: the test hands over the fetched page of a walked-through fixture and none of its post-form captures.
- [ ] Commit: `monitor: settled pages handed to Loupe capture`

**Test checkpoint:** `pnpm exec vitest run test/monitor/training.test.ts` passes, and fails if a settled page is stored twice or an unsettled one is stored.

## 12. Monitor case allowance and quality

> **Started:** 2026-11-02T23:43Z

Monitor investigations must not consume the member's own checking allowance, and the pipeline's quality (destination, form and confirmation accuracy, latency, cost, and each model's measured contribution) needs a corpus before any superiority claim (D05 T04 §4 completion review, filed 2026-11-02).

**Phase:** 7
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Separate the allowances. Done when: a monitor investigation never refuses or consumes a member check.

- [x] Give monitor cases their own case-limit accounting in `src/db/cases.ts` (the system uploader's cases bounded per organisation per day, separately from member traffic). Done when: `test/monitor/pipeline.test.ts` proves a member at their daily limit still gets investigations, and monitor cases stop at their own bound.
- [ ] Measure the pipeline on the labelled monitor corpus: destination and form decisions, confirmation accuracy, latency, cost per investigation, and the Spark, SAM and walkthrough contributions by ablation. Done when: the frontier entry names each rate with its denominator and the measured cost, with the spend cap stated before any paid call.
**Corrected 2026-11-02** (plan review, 4 P2, `docs/reviews/05-trust/D05-T04-s12.md`): (1) the monitor bound is 50 cases per organisation per SAST day (`MONITOR_CASES_PER_DAY` in `src/db/cap-rule.ts`, the run's own 50-capture bound, one investigation per flagged capture at most), counted with the same failed-admission release as the member cap. (2) Enforcement is atomic on the creation path monitor cases actually take (`createCase` with the system uploader `monitor`, a conditional insert like admission's), and `MEMBER_CASES_TODAY` excludes monitor cases, so neither traffic uses the other's allowance. (3) A capped creation states itself: the investigation settles `partial` and readable as the daily monitor allowance reached, no case is created and no model is called, and a later run after rollover retries the capture. (4) The measurement item's harness is buildable now; its rates wait on full-pipeline ground truth the 40-page screen corpus does not carry, so the item stays open until that corpus exists, with its numeric spend cap stated before any paid call.

- [ ] Commit: `monitor: investigation allowance and quality measurement`

**Test checkpoint:** `pnpm exec vitest run test/monitor/pipeline.test.ts` passes with the allowance cases.

## Verification

- The demo lookalike is found by the scheduled run, screened, investigated and alerted with a takedown pack.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
