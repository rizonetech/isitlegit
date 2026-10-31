# Phase run: Phase 0, lane glimmer (D03)

Continues run bb75ca0ee0fb from `docs/phase-runs/2026-10-28-phase-0.md` (that file is the record up to 2026-10-30 12:57 UTC, written before lanes existed). From here the run counts the glimmer lane's rows only: the whole D03 domain (`todo/lanes.json`, main's D00 T01 §19 merged at 7b02eb5).

## Audit

1. Graph: valid, 264 sections; `query lane` names lane glimmer (branch glimmer-screener, domain D03).
2. Plan currency: `plan --check` current after the merge of main (7b02eb5).
3. Ready rows: 7 (D03 T04 §10, D03 T03 §2, D03 T04 §19, §22, §23, §27, §28); 42 lane rows, 20 verified.
4. Blocked rows: 15 (D03 T04 §11, §12, §13 wait on §10; D03 T02 §1 to §4, D03 T03 §1, §3, §4, D03 T04 §1, §14, §15, §17, §25 on their dependencies or Needs).
5. Phase being worked: Phase 0, D03 T04 §10 first (the 1.0 build is deduplicating; its leak check, figures and stamp follow, then training under §11).

## Phase repairs

## Shipped-row verification

## Gap audit

## Sections

- D03 T04 §10 (stamped ce93b5e, merged to main as 5bce406): five 1.0 builds. The first refused on the sample floor (shared hosts chained 28,334 pages, the common brands' group held out whole, the split blind to training's floor); the second 3 evaluation pages short (agreed pages dropped for unchecked twins); the third stopped by the out-of-memory guard while publishing (line files joined in memory); the fourth refused on 8 public lines naming the client. Each fixed at its layer with a test and reviewed (rounds 5 to 10). The fifth published: training 52,019 lines, evaluation 1,000 (545 South African), files 13.7 GB and 257 MB; leak checks clean.
- D03 T04 §11 (open): training started 2026-10-30 23:58 SAST, job ts-026d14227a0042128f9dd410c648d329, all 52,019 lines, about 9 s a step of 8, due about 16:30 SAST on 2026-10-31; detached, pinned to cores 4 and 5, resumable from its checkpoints (08492a0). Its progress lines land in `docs/glimmer/training.md` and are committed with each push.
- D03 T04 §13 (open): the evaluation runner `scripts/glimmer/evaluate.ts` is being built (Loupe and Spark answers, resumable, metrics.json for the version gate and the model card).
- D03 T04 §22 (open): items 18 to 21 and 23 ticked; the bench exits 1 (two-sources raw ratio 1.040, start-up the larger part; gigabyte refetch varies with the cut). Recorded in the section.
- D03 T04 §27 (open): per-version freeze, held-out by id and by source item (1.0's list written from the store), lure accounting, exact size cut; the sweep and its figures remain.
- D03 T04 §28 (open): plan review gaps 1 to 7 folded in; item 1 (converter limits) being built.
- D03 T04 §19 (open): the redaction-key change ordered after held-out-by-item, now built.
- D03 T03 §2 (leftover here): needs Cloudflare (R2), a host this session does not use.
- 2026-10-31 15:37 UTC, D03 T04 §11: late plan review (gaps folded and built), completion review (G1 to G5, E1 to E3 implemented), rounds 1 to 3 fixed, round 4 clean; stamps once the bill settles (the record item, after 2026-11-01 12:49 UTC).
- 2026-10-31 15:37 UTC, D03 T04 §12: Started line recorded late, late plan review at a1b19e81 (gaps 1 to 4 built), completion review (G1 to G6 implemented), rounds 1 to 3 fixed, round 4 clean; every item ticked; stamps after §11, its prerequisite.
- 2026-10-31 15:37 UTC, D03 T04 §13: late plan review at 7172b0c4; gaps 1, 3, 8 built (warm-up receipts, the bar only on complete runs, answers bound to their model), gap 2 in part (`--max-minutes`, cost null), gap 6 built (`causes`), gaps 4 and 5 folded as corrected and new items. Warm-up 1: 195.0 s cold start, scale to zero 319 s after the last request. Spark at about 300 of 1,000 pages.
- 2026-10-31 15:37 UTC, D03 T04 §19: round 5 clean; stamp waits on main's pass_schedule fix (coordinator, in review).

## Critical events

- 2026-10-30 12:57 UTC: guard re-pointed to this lane run file (session 229f8f2d-cbef-4f47-a5c0-f486f35ff2ff, generation 46b878713709, heartbeat job 97c4bd3d replacing a0430ea3); the re-point minted run id 61e60c209808, which every end marker of this run now carries; the heartbeat is recreated from the lane-aware process-plan prompt, and `campaign_guard.py rows` reads lane=checkout ready=7 open=22.
- 2026-10-31 14:20 UTC: crash recovery (the machine went down about 13:57 UTC and rebooted 13:59 UTC; session 229f8f2d is gone). Guard taken with `acquire --handover crash-recovery` by session c7e5ade5-5af7-4b47-84c4-bbb96e990bd2, heartbeat job 74486f93, generation e9b3a20ea21c, run id 61e60c209808 kept. The §19 round 4 redesign was found intact and uncommitted in the tree and is carried on from there.
- 2026-10-31 14:21 UTC: Muse Spark's held-out run (§13) resumed with `node scripts/glimmer/evaluate.ts spark 1.0 --retry-errors` (detached, log `~/isitlegit-data/glimmer/runs/eval-1.0-spark.log`) from 101 recorded pages (5 errors re-asked); spend so far US$0.74, about US$0.0074 a page, projected about US$7.4 for all 1,000, inside the US$10 default and Glimmer's US$30 cap. The one call in flight at the crash stays reserved at its estimate in the ledger by design.
- 2026-10-31 14:20 UTC: `deploy.ts eval-down` refused by Fireworks: "deployment has received inference requests in the last hour, pass ignore_checks to skip this check". That one-hour check is the unrecorded reason teardown was planned for after 16:35 SAST (Loupe's held-out run sent its last request about 13:33 UTC). Nothing else needs `isitlegit-loupe-eval`: Loupe's 1,000 pages are all answered with no error left, and Spark runs on Meta. The delete is retried from 14:34 UTC rather than overriding the in-use check.
- 2026-10-31 14:34 UTC: the retried delete went through; `eval-down` misread Fireworks' soft delete (state DELETED) as still there, fixed in `deploy.ts` `remove()` with a regression test; `isitlegit-loupe-eval` read deleted at 14:44 UTC.
- 2026-10-31 14:42 UTC: coordinator: the Spark run held the shared Meta ledger lock for the whole run, blocking the eval lane's D08 T01 §3 spend (refused 14:32 UTC, US$0.00 spent). Fixed in f9e36a0b (`withLedgerLock()`, per reserve and settle; the run's own lock is `spark.lock` beside its answers; the teacher had the same defect, fixed too). The run was stopped right after page 231 landed (pid 43768; one reservation, ariyadasa-2021-731c5c35e715bd05 at US$0.0194, stays at its estimate) and resumed on the fix as pid 308844 with `--retry-errors`; coordinator and eval lane told.
- 2026-10-31 14:33 UTC: §19 round 5 (low, quality): approve, HIGHEST none. §12's two open items recorded and ticked from the 13:54 UTC key check (200 answered, 403 on the change). §11 and §12 had no plan review; both run late against their build-start commits (c2573903, 89863c63), as §7's was.

## Lessons
