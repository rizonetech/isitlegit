# Phase run: Phase 5 (console lane)

Started from process-plan during Phase 6 (docs/phase-runs/2026-10-31-console-phase-6.md, run d1b36ec3d3ab) when D07 T08 §8 was filed in Phase 5 at the coordinator's request and ordered next (the trust lane's D05 T02 §1 depends on it). Phase 6 resumes after this phase closes.

## Phase repairs

- `resolve 'D07 T08 §8'`: exit 0, the lane's only Phase 5 row.

## Shipped-row verification

- D07 T02 §8 (plans and the trial, its prerequisite): stamped; `src/auth/plans.ts` and `src/auth/plan-sql.ts` read in full before the build.

## Gap audit

## Sections

## Critical events

- 2026-10-31 guard re-pointed from Phase 6: session 8962aad5-595e-41c2-bdae-0e68ae7a5dcb, heartbeat job 5c0a5dcd, generation 6e9000adb023; old job b261f2f2 deleted. D07 T04 §3 stamped in 139aefd2 before the re-point; origin/main merged at 5623e3b6.

- 2026-10-31T18:13Z CI red on console-lane at f710f177 (ci.yml run https://github.com/rizonetech/isitlegit/actions/runs/41226999050): Worker tests (2 of 3) "has timed out after 15 minutes" between files (last file test/invoice/forensics-generated.test.ts passed; no assertion failed). The known shard stall other lanes have recorded (main 41189018544, app-lane 41184108098; ci.yml and vitest.config.ts are the coordinator's). One `gh run rerun --failed` issued; a second red on this commit is a real failure.

## Lessons

- Seven Worker test files run together on two cores hung inside miniflare's Workflow binding after their tests ran; each file passes alone (CI shards them). Run touched Worker files one or two at a time locally.

## Closeout run=1e59018d4606

- Shipped: D07 T08 §8 (a plan tier sets its organisation's daily case cap), stamped in bf89169e on candidate f710f177; CI run 41226999050 green on every job after one rerun of a Worker shard stall (timed out between files, no assertion failed).
- Built: migration 0055 (override column, non-50 caps carried across, Fynbos Freight held at 50), `dailyCapSql` and the override statements in `src/auth/plan-sql.ts`, admitCase, todayUsage and the cap notice reading it, a cap of 0 told as a pause (upload page, zone, email), the eval probe and its pre-0055 recovery moved to the override. Cross-lane edits (checks, app, eval lanes) approved by the coordinator and told to each.
- Plan: the plan review's four gaps corrected before the build; D07 T05 §1's cap item corrected to the override; D07 T08 §4 notes it reads the shared cap.
- Open with other lanes: the checks lane's D01 T03 §12 also changes admitCase's cap clause (keep both at the merge, agreed); the app lane builds the shared "Checked by" read in D07 T03 §42.
- Next: Phase 6 (D07 T08 §1 and the other ready rows).
