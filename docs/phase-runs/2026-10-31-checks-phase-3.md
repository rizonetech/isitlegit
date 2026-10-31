# Phase run: Phase 3, the checks lane

Started 2026-10-31 14:20 UTC by `process-plan`, scope plan, on branch `checks-lane`, resuming after the machine crash of 15:57 SAST. Continues `docs/phase-runs/2026-10-30-checks-phase-2.md`, whose run `40dfd8b5ef89` the coordinator parked in recovery; its Resume point names D01 T01 §19 (Phase 3), so this run opens Phase 3's own run file.

## Plan audit

- Graph: `validate` reports 357 valid sections; lane `checks` (D01, D02, D04, plus D08 T01 §1).
- Ready rows: `query ready` lists D01 T01 §19 first (Phase 3), then D01 T02 §10 and the rest of the lane's rows.
- CI: `ci_status.py --branch checks-lane` green at 2eb2ffc5 (run 41208666256), which holds the §19 fix 37293ea4, round 2 clean at ea77d3b4 and the `origin/main` merge c4fcb619.
- Phase started: 3, because the open section D01 T01 §19 belongs to it and only its stamp remains.

## Phase repairs

- 2026-10-31T14:40Z `validate` 357 sections, `plan --check` current. `resolve` exits 0 for all 16 ready Phase 3 rows of this lane; D01 T03 §3 (`meta-api`) and D02 T07 §2 (`cloudflare`) are host-bound and re-checked for reach when their turn comes. Blocked: D01 T03 §4 and §5 (behind §3, `meta-api`), D02 T06 §4 (behind T06 §1 to §3 and T03 §2), D02 T07 §3 and §4 (behind T07 §2, `cloudflare`), D02 T03 §7 and §10 (behind T07 §1 and §3). No broken references.

## Shipped-row verification

- D01 T01 §19 stamped this run (checkpoint re-run green above); the other spine rows are re-checked inside each section's resolve.

- 2026-10-31T14:45Z D01 T02 §10 corrected at start: its only item waits for D07 T03 §20 (the app lane's Retry control, open) but did not depend on it; the dependency is now in its row, so it waits on the app lane's D07 T03 §20.

## Sections

- D01 T02 §11 Authentication results in the reply: started 14:55Z; plan review 2 P2 folded in (an unreported method carries no panel; the tests assert each value's words). For the coordinator: the app lane's reply template (D07 T03 §7) has no word for a method the receiver did not report; a "not reported" state in its Headers checked panel is asked of that lane.

- D01 T01 §19 A retried run's earlier findings kept apart: stamped (plan review 1 P1 folded in; completion gap fixed in 37293ea4, attempt history filed as D01 T01 §20; round 1 outage, round 2 clean). Checkpoint 32 tests plus `report-access` 34; migration 0051 and its live proof are the coordinator's at deploy.

## Critical events
- 2026-10-31T14:22Z run guard taken by handover (crash-recovery) from the lost session `3be2e4be`: session `e2992300-cd56-42a9-80fb-87291ff7b859`, heartbeat job `eba3955d`, generation `81e8126ed0e5`, run `e78fd72088d9`, scope plan, lane checks.
- 2026-10-31T14:35Z D01 T01 §19 stamped on 37293ea4 (CI green at 2eb2ffc5, run 41208666256): plan review gaps folded in; completion gaps, the in-scope one fixed in 37293ea4, the attempt history filed as D01 T01 §20; round 1 an outage (Astra exited 1), round 2 clean on all four lenses.
- bookkeeping: heartbeat resumed 2026-10-31T14:28Z (plan review of D01 T02 §11 in flight; nothing touched until it returned)
- bookkeeping: heartbeat resumed 2026-10-31T14:35Z (completion review of D01 T02 §11 in flight; nothing touched until it returned)
- 2026-10-31T14:40Z D01 T02 §11 built at 64166e86; completion review: gaps, all six out of scope and the app lane's (D07 reply template), asked of the coordinator for filing; the stamp waits for those refs, the rounds go on. Lesson: this lane's tests run pinned to `taskset -c 6,7` (AGENTS.md); from here on they are.
- bookkeeping: heartbeat resumed 2026-10-31T14:42Z (round 2 of D01 T02 §11 in flight)
- 2026-10-31T14:44Z D01 T02 §11 round 1 fixed (P2: DKIM none would read "not set up"; d423d5cb), round 2 clean. The app lane filed the completion gaps as D07 T03 §34 to §37 (app-lane a2ac9849); the stamp waits for them on main, then merges main and files the producer halves in D01.
