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

## Critical events

- 2026-10-31 11:22 SAST: run started by session ad053306-b218-42e2-af20-9bbaed0b4268, heartbeat job aeb6edab, generation db688fe409f6, run 9deb2696c9a2, scope plan.

- bookkeeping: heartbeat resumed 2026-10-31T10:09Z; D03 T03 §2 live logo capture running (generation 20261031T100831Z); breaker trip 1 was the wait on that capture, not a stall
- 2026-10-31 12:13 SAST: the session reaped the capture task under machine memory pressure; the capture itself had finished (generation 20261031T100831Z: 12 real brands, 2 fictional, 11 missing). No browser restarts until free memory is above 3000 MB (AGENTS.md Machine); the remaining 8 brands need selector work (FNB and Nedbank too small, Microsoft, Sage, FedEx, Takealot, PayPal, Yoco selectors; Adobe and Aramex answer Access Denied to headless Chromium; DHL times out).
- 2026-10-31 12:19 SAST: breaker trips reached 2 while D03 T03 §2 waited on its live logo capture (a long browser job outside the tree, one browser at a time under the machine memory limit), so the heartbeat ended the run as a stall (`end --reason stall`). Nothing is blocked: the capture is running (generation 20261031T101839Z) and the section resumes when the operator says resume.
- 2026-10-31 12:26 SAST: resumed on the operator's "resume" (relayed by the coordinator, 12:25 SAST); new run b9817566e0bf, heartbeat job bd1893d0, generation 56286c505df7, scope plan. Long jobs run in the foreground from here.

## Lessons

- A live capture that runs longer than three turn ends trips the stall breaker; launch long jobs in the foreground (under the 10-minute tool limit) or split them per brand so the tree moves between pushes.
