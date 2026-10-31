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

- D03 T04 §10 (open): code complete; rounds 1 to 4 (round 4 approve, 24179bc). The 1.0 build started 13:16 SAST, read 129,892 pages, admitted 127,890, and is deduplicating (pinned to cores 4 and 5). Remaining: its leak scan, the figures in `docs/glimmer/training.md`, the stamp.
- D03 T04 §11 (blocked on §10): probe bill reconciled at US$0.00 (71ba752); resume from the newest checkpoint (08492a0); the version line at job start (ebbfb09). Remaining: the run itself and its records.
- D03 T04 §27 (open): items 1 and 2 (per-version freeze ca51c66, held-out reservation c8cae5e), the brief item, the lure accounting (b2c1e6b), and the exact size cut in deduplication (051ce1f). Remaining: item 4 after §22, the sweep, its converters and figures.
- D03 T04 §22 (open): rounds 1 and 2 done; remaining gap 9, the measured two-source bench run on a quiet host (during training).

## Critical events

- 2026-10-30 12:57 UTC: guard re-pointed to this lane run file (session 229f8f2d-cbef-4f47-a5c0-f486f35ff2ff, generation 46b878713709, heartbeat job 97c4bd3d replacing a0430ea3); the re-point minted run id 61e60c209808, which every end marker of this run now carries; the heartbeat is recreated from the lane-aware process-plan prompt, and `campaign_guard.py rows` reads lane=checkout ready=7 open=22.

## Lessons
