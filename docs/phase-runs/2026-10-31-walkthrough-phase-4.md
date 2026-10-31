# Phase run: walkthrough lane, Phase 4 (D04 T02, D03 T03)

## Audit

1. Graph: valid, 330 sections; lane `walkthrough` (branch `walkthrough-lane`, sections D04 T02 §1 to §6 and D03 T03 §1 to §4).
2. Plan currency: `plan --check` reads `plan current`.
3. Ready rows: 2, both Phase 4: D04 T02 §2 (Needs none), D03 T03 §2 (Needs cloudflare; `wrangler whoami` signs in as the Rizonetech account, reachable).
4. Blocked rows: 8. D04 T02 §1 waits on D02 T07 §2 (checks lane); §3 on §2; §4 on §3 and D03 T01 §6; §5 on §4; §6 on §5 and D02 T07 §3 (checks lane); D03 T03 §1 on D03 T02 §1 (glimmer lane render) and D03 T01 §5; §3 on §1 and §2; §4 on §3.
5. Phase started: 4, the only phase holding this lane's rows.
6. Script suites: `scripts/tests` 91 OK (1 skipped), `tests/scripts` OK (2 skipped).

## Phase repairs

- D04 T02 §2 migration number: the coordinator assigned `0046_canaries.sql` (2026-10-31 11:21 SAST); the section's `0009` is corrected with a dated note.

## Shipped-row verification

## Gap audit

## Sections

- D04 T02 §2 per-case canary credentials: stamped d9ad0f20 (code a17cdf71). Plan review gaps P2 x3 planned in 17a41622; completion `filed` (every gap already owned: D04 T02 §1, §3 to §6, D07 T03 §13); round 1 clean. Migration 0046. Checkpoint 11/11.
- D03 T03 §2 reference logo store: production load handed to the coordinator 2026-10-31 12:58 SAST: `load --remote --dry-run --generation 20261031T105740Z`, `load --remote --generation 20261031T105740Z`, `--check --remote`, reverse `load --remote --restore`. Keys (23, bucket `isitlegit-artefacts`): `ref/logos/20261031T105740Z/{standard-bank,fnb,absa,nedbank,discovery-bank,tymebank,microsoft,google,apple,docusign,sars,xero,sage,aramex,postnet,takealot,netflix,paypal,payfast,yoco,protea-bank,nimbusmail}.png` and `ref/logos/index.json`. Missing: adobe, dhl, fedex.
- D03 T03 §2: after round 1 the store was recaptured with the fixed code; generation `20261031T115449Z` supersedes `20261031T105740Z` in the coordinator handover (re-sent 2026-10-31 14:00 SAST): `load --remote --dry-run --generation 20261031T115449Z`, `load --remote --generation 20261031T115449Z`, `--check --remote`, reverse `load --remote --restore`. Keys: `ref/logos/20261031T115449Z/{standard-bank,fnb,absa,nedbank,discovery-bank,tymebank,microsoft,google,apple,docusign,sars,xero,sage,aramex,postnet,takealot,netflix,paypal,payfast,yoco,protea-bank,nimbusmail}.png` and `ref/logos/index.json`.
- D03 T03 §2 reference logo store: stamped (plan review P1 x1, P2 x4 planned; completion `filed` with 5 gaps built in-section and D03 T03 §5 filed; round 1 P1 provenance, P2 fallback cap, P3 dry run fixed; round 2 P1 truncated fallback image fixed; round 3 P2 box bound fixed; round 4 clean). Local store generation `20261031T115449Z`, 20 real brands. Production load is the coordinator's.
- D03 T03 §2 live proof (coordinator, 2026-10-31 14:45 SAST, deploy 46e92188): the `--remote --dry-run` showed only `ref/logos/` writes, `load --remote --generation 20261031T115449Z` wrote 23 objects, and `--check --remote` printed `reference logos: 20 brands in R2 (2 fictional, 3 missing; generation 20261031T115449Z)`. Migration 0046 (D04 T02 §2) applied in the same deploy.
- D04 T02 §3 contained driver, in progress (2026-10-31 15:00 SAST): plan review (P1 x5, P2 x4) planned in ea54c406; URL policy committed d09dd45a; driver and migration 0050 built, `test/walkthrough/driver.test.ts` and `url-policy.test.ts` 21/21 on local Browser Run; a probe showed browser-wide `Fetch.enable` catches popup and worker requests, so every request is answered by the Worker's fetch. Mutation runs, one per limit, in progress (steps: caught).
- D04 T02 §3 resumed after the crash (2026-10-31 16:23 SAST): driver test rerun showed 2 failures. The Blob download test's fixture called `document.URL` (a string inside an inline handler), fixed in 62dee6a0; a `target=_blank` popup is `noopener`, so Puppeteer reported no opener and it stayed open: popups now close by CDP `openerId` (62dee6a0); the popup follow ran beside the action's screenshot, whose capture was never answered across that navigation: follow moved inside `execute` (fb2e7872). Walkthrough tests 39/39; checkpoint mutations, one per limit (steps, wall clock, scheme, private address, redirect hop, popup policy, non-http link, download, canary typing, key allowlist), all caught, plus popup close, never-navigating popup sweep and the worker guard. Completion findings answered in the findings file.

## Critical events

- 2026-10-31 16:25 SAST: guard handed over after the crash (`acquire --handover crash-recovery`): session 5e443bb6-3e90-45b1-97a3-fa3f49be8df5, heartbeat job 62e58683, generation e89027d7951d, run b9817566e0bf.
- 2026-10-31 11:22 SAST: run started by session ad053306-b218-42e2-af20-9bbaed0b4268, heartbeat job aeb6edab, generation db688fe409f6, run 9deb2696c9a2, scope plan.

- bookkeeping: heartbeat resumed 2026-10-31T10:09Z; D03 T03 §2 live logo capture running (generation 20261031T100831Z); breaker trip 1 was the wait on that capture, not a stall
- 2026-10-31 12:13 SAST: the session reaped the capture task under machine memory pressure; the capture itself had finished (generation 20261031T100831Z: 12 real brands, 2 fictional, 11 missing). No browser restarts until free memory is above 3000 MB (AGENTS.md Machine); the remaining 8 brands need selector work (FNB and Nedbank too small, Microsoft, Sage, FedEx, Takealot, PayPal, Yoco selectors; Adobe and Aramex answer Access Denied to headless Chromium; DHL times out).
- 2026-10-31 12:19 SAST: breaker trips reached 2 while D03 T03 §2 waited on its live logo capture (a long browser job outside the tree, one browser at a time under the machine memory limit), so the heartbeat ended the run as a stall (`end --reason stall`). Nothing is blocked: the capture is running (generation 20261031T101839Z) and the section resumes when the operator says resume.
- 2026-10-31 12:26 SAST: resumed on the operator's "resume" (relayed by the coordinator, 12:25 SAST); new run b9817566e0bf, heartbeat job bd1893d0, generation 56286c505df7, scope plan. Long jobs run in the foreground from here.

## Lessons

- A live capture that runs longer than three turn ends trips the stall breaker; launch long jobs in the foreground (under the 10-minute tool limit) or split them per brand so the tree moves between pushes.

PARKED 2026-10-31T14:05Z run=b9817566e0bf operator-stop: the operator parked the walkthrough lane to free memory (relayed by the coordinator, 15:52 SAST); the machine crashed (rebooted 15:59 SAST) mid-park with the fixes uncommitted, so the coordinator committed them as wip and recorded this park in recovery.

### Resume point

- Section: D04 T02 §3 (contained driver). Built at 62d55962; its completion review (astra, 13:31Z) found it not complete, recorded in `docs/reviews/04-agent/D04-T02-s3.md`.
- In the wip commit, unreviewed: fixes for the completion findings in `src/walkthrough/driver.ts` (browser-level download denial, worker constructors removed, more) and their tests in `test/walkthrough/driver.test.ts`.
- Rerun first: `test/walkthrough/driver.test.ts`; the blob-download test still failed at the park. Leftover `mut.py` processes died in the crash.
- Take the guard with `campaign_guard.py acquire --handover`; session ad053306 is gone.
