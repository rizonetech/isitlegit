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

- D01 T02 §12 A forwarding refusal alerted within minutes: started 14:50Z. Corrected at start: the mail-handler premise fails (Cloudflare drops refusal notices) and five minutes cannot hold the attribution; the 47 minutes came from a grace counted from the reading and quarter-hour scans. Target now 25 minutes; the live measurement split to §14 (`live-mail`), an early unattributed alert filed as §15 (`owner-decision`, Phase 6). Process slip: the code was drafted before the plan review; it was stashed while the review read the corrected section, and only then committed.

- D01 T02 §12 stamped on 4897c378: plan review 2 P2 folded in; completion gaps, one in scope implemented (c096cdac), three owned by §13, §14, §15; rounds 1 and 2 fixed (P2 each: a cluster's every notice waits `SEEN_MS`, each cluster built whole first), round 3 clean. 50 tests across forwarding, scheduled and crons. Needs the coordinator's deploy (`FORWARD_CRON`, a third trigger); §14 measures it live after.

- D01 T03 §3 Muse Voice Transcribe client: started 15:25Z (`meta-api` reachable: `check-meta-key.py` exit 0, the credit line present). Corrected at start: the Workflow's `transcribe` step added, chunk-scoped speakers, the fixture from Windows' own voices; plan review 4 P2 folded in. Asked of the coordinator: the WAV reservation fix in `src/meta/client.ts` (D03) and a D07 section for the step's report words.

- D02 T01 §4 Check revision stored with each outcome: started 15:12Z (waited on migration 0053, given 15:16Z). Corrected at start: the binding exists, the table is run-keyed, twelve outcome rows a statement; plan review 1 P1 + 1 P2 folded in.

- D01 T02 §11 stamped on d423d5cb (CI green at f4eb8f13, with the main merge): plan review 2 P2 folded in; completion gaps all out of scope, filed as D07 T03 §34 to §37 (the app lane's) and D01 T02 §16 and §17 (their producer halves here); round 1 fixed (P2: DKIM none would read "not set up"), round 2 clean. 118 tests across reply, reply-step, resend, reply-design and the Workflow.

## Critical events
- 2026-10-31T14:22Z run guard taken by handover (crash-recovery) from the lost session `3be2e4be`: session `e2992300-cd56-42a9-80fb-87291ff7b859`, heartbeat job `eba3955d`, generation `81e8126ed0e5`, run `e78fd72088d9`, scope plan, lane checks.
- 2026-10-31T14:35Z D01 T01 §19 stamped on 37293ea4 (CI green at 2eb2ffc5, run 41208666256): plan review gaps folded in; completion gaps, the in-scope one fixed in 37293ea4, the attempt history filed as D01 T01 §20; round 1 an outage (Astra exited 1), round 2 clean on all four lenses.
- bookkeeping: heartbeat resumed 2026-10-31T14:28Z (plan review of D01 T02 §11 in flight; nothing touched until it returned)
- bookkeeping: heartbeat resumed 2026-10-31T14:35Z (completion review of D01 T02 §11 in flight; nothing touched until it returned)
- 2026-10-31T14:40Z D01 T02 §11 built at 64166e86; completion review: gaps, all six out of scope and the app lane's (D07 reply template), asked of the coordinator for filing; the stamp waits for those refs, the rounds go on. Lesson: this lane's tests run pinned to `taskset -c 6,7` (AGENTS.md); from here on they are.
- bookkeeping: heartbeat resumed 2026-10-31T14:42Z (round 2 of D01 T02 §11 in flight)
- 2026-10-31T14:44Z D01 T02 §11 round 1 fixed (P2: DKIM none would read "not set up"; d423d5cb), round 2 clean. The app lane filed the completion gaps as D07 T03 §34 to §37 (app-lane a2ac9849); the stamp waits for them on main, then merges main and files the producer halves in D01.
- bookkeeping: heartbeat resumed 2026-10-31T14:56Z (completion review of D01 T02 §12 in flight)
- 2026-10-31T14:59Z D01 T02 §12 built at 7ae9b0ac; plan review 2 P2 folded in; completion gaps: one in scope (a D1 write-failure regression, c096cdac), three already owned by §13, §14 and §15.
- bookkeeping: heartbeat resumed 2026-10-31T15:06Z (round 3 of D01 T02 §12 in flight)
- bookkeeping: heartbeat resumed 2026-10-31T15:14Z (plan review of D01 T03 §3 in flight)
- 2026-10-31T15:16Z the coordinator gave migration 0053 to D02 T01 §4; FORWARD_CRON is within the account's limit (Workers Paid).
- 2026-10-31T15:18Z process slip, repaired: a `git stash pop` of this lane's §4 draft conflicted with §3's newer text (lanes share one stash list), and the `&&` chain stopped while the commit after `;` ran, committing conflict markers into `todo/01-intake/TODO-03-upload-and-voice.md` (3245d855); repaired in a73dcb8d (the reviewed §3 text exactly), only this lane's stash dropped, the lesson kept in memory.
- 2026-10-31T15:18Z D01 T02 §12 was stamped (f5787f2d) on branch CI green at 66d3c9a3, before its own code; the full suite on f5787f2d is in progress (run 41213395249), checked before the next stamp; a red there reopens §12.
- 2026-10-31T15:26Z red on checks-lane (ci.yml, f5787f2d, run https://github.com/rizonetech/isitlegit/actions/runs/41213395249, Worker tests 3 of 3): `test/node/mail-settle.test.ts:59` still pinned two cron schedules after D01 T02 §12 added `FORWARD_CRON`; this lane's miss (only `test/node/crons.test.ts` was updated). The pin now lists the three schedules, and a search finds no other; the rest of the shard passed (972). §12's stamp stands once this goes green; the next stamp waits for green on its own head.
- bookkeeping: heartbeat resumed 2026-10-31T15:25Z (completion review of D02 T01 §4 in flight; the red waited for it)
- 2026-10-31T15:30Z D02 T01 §4 built at 5eb33504; completion review gaps both out of scope (D02 T01 §5 filed here; a D07 report view of the revisions asked of the app lane); round 1 clean on all four lenses. The stamp waits for the D07 ref.
- 2026-10-31T15:42Z red on checks-lane again (run 41214923673, d14ca27c, Worker shards 2 and 3): two tests read check_outcomes against the schema before 0053 (the report test's raw rows; the 0051 migration test reading through today's readers on 0051's schema). Fixed in b6f745b4 at the tests' expectations; every test touching outcomes (17 files) and every Workflow, voice and client test (43 files, 872) run locally. Lesson: after a schema change, run every test that reads the table, not only the section's own.
- 2026-10-31T15:56Z merged origin/main (c2666e50, gated green) at 631c2e3f: D07 T03 §34 to §37 resolve; D01 T02 §16 and §17 filed as their producer halves; D01 T03 §3 built at 60fc8b93 (the live run next).
- 2026-10-31T16:02Z D01 T03 §3's live run refused by the smoke's guard before any secret was read: the shared US$2 a day (`scripts/meta-smoke.ts` DAY_CAP, the ledger outside every checkout) is spent today by the lanes' live calls. The run (about 41 seconds of audio, about US$0.002) waits for the next SAST day, from 22:00 UTC; `node scripts/voice-transcribe-live.ts` then runs it. The guard is not bypassed.
- 2026-10-31T16:19Z D01 T03 §3 round 1 fixed (P2: a 200 the client cannot read is final, c0b69e16), round 2 clean; the stamp waits for the live run after 22:00 UTC.
- 2026-10-31T16:19Z production defect from the coordinator (the media lane's capture, Fynbos Freight, 18:05 SAST): an uploaded .eml showed Checking, held its claim (a re-upload got 503 "still being taken"), then vanished by 16:17Z. Cause at its layer: the upload route awaits `admitDelivery` without `ctx.waitUntil`, so the browser leaving (a sign-out) cancels the work after the case and claim are written and before `ANALYSIS.create` (Cloudflare: work may be cancelled when the client disconnects unless passed to `waitUntil`); then `settleStale` in `src/intake/admit.ts` removes a `received` case with no Workflow, silently. Filed as D01 T03 §12, with the intake check's wrong reason on an uploaded email (`src/checks/intake.ts:102`).
- 2026-10-31T17:16Z D01 T03 §12: completion gaps G1 to G3 implemented (96061eb5); round 1 fixed (P2: a store error with the file committed took it for missing, 5fa5a291), round 2 clean. The stamp waits for CI green on its head.
- bookkeeping: heartbeats resumed 2026-10-31T16:57Z, 17:11Z, 17:15Z (§12's reviews in flight)
