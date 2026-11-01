# Phase run: Phase 2 again, the eval lane

Started 2026-10-31 11:26 UTC by `process-plan`, scope plan, on branch `eval-lane`: D08 T01 §1 (the checks lane's loader) reached main at 93d9b8e4 and was merged in at 80bd6c49, so D08 T01 §2 is ready. Phase 6 is parked on the operator's live run of D09 T01 §1 (`docs/phase-runs/2026-10-31-eval-phase-6.md`); the coordinator allowed D09 T01 §1's reviewed, unstamped code to ride to main with D08 T01 §2's stamp (2026-10-31 11:24 UTC), its script still refusing without `--confirm-production`.

## Sections

- D08 T01 §6 Second readings imported from the review: stamped (plan review P1 + 2 P2 folded in; completion review 4 gaps, all implemented; rounds 1 to 4 fixed: half-import on a kill, duplicates across files, recovery bound to the journal, flushes for power loss; round 5 clean). `node eval/import-readings.ts` imports a review's verdicts as one journalled, durable transaction; no dispatcher change.

- D08 T01 §5 Label rationales and adjudication: stamped (plan review P1 + 2 P2 folded in; completion review was also the second reading: 42 agree, 6 disagree, settled; 3 gaps implemented, 1 filed as D08 T01 §6; round 1 clean and confirmed the recorded readings). The Nazario set is 55 (45 model-basis, each read twice), 5 pending.

- D08 T01 §4 Labels for attacks only a model can see: stamped (plan review P1 + 2 P2 folded in; completion 1 gap implemented, 1 filed as D08 T01 §5; round 1 clean). `basis` on `Label` (coordinator option A), 48 Nazario messages labelled by reading, 2 pending; the draw reconciled. 25 tests; the loader's own tests unchanged.

- D08 T01 §2 Public corpora chosen by licence: stamped (plan review P1 + 2 P2 folded in; completion 2 gaps, one implemented and one filed as D08 T01 §4; round 1 two P3 fixed, round 2 clean). Seven corpora decided, Nazario (CC BY 4.0) accepted; a seeded random draw of 60, 10 labelled and 50 pending; 31 messages passed over across the selections for holding a client's name. 20 tests.

- D08 T03 §9 Frontier images out of the eval sets folder: stamped (plan review P2 folded in; completion complete; round 1 clean). 53 tests; the unlabelled-folder and missing-path mutations caught. Unblocks D08 T01 §2.

## Critical events
- 2026-10-31T11:26Z run guard re-pointed: heartbeat job `374a1421`, generation `5b3ea624bf56`, run `819396a01eeb`, scope plan, lane eval.

## Closeout run=819396a01eeb

Eval's share of Phase 2 is complete: `query stats --phase 2` reads 6 of 6 verified. The whole suite ran green on the stamped head 98428db7 in CI (run 41204343287, every job passed), read from CI rather than locally, per the lane brief.

- Shipped: D08 T03 §9 (frontier images out of the sets folder), D08 T01 §2 (public corpora by licence; Nazario CC BY 4.0, a seeded draw of 60), D08 T01 §4 (labels for attacks only a model can see, `basis` on `Label`), D08 T01 §5 (rationales and second readings; 6 disagreements settled), D08 T01 §6 (the readings import, `node eval/import-readings.ts`, a journalled durable transaction).
- Repaired: two Started lines re-recorded on corrected contracts; a sampling bias replaced by a seeded random draw; client names kept out by check-publication and the draw script.
- Learned: a review's fixed per-path form plus a validated import beats transcription. A two-file write needs a journal named by the data, not by the retry's arguments, and flushes in transaction order; each review round found the next layer of that.
- Next: D08 T01 §3 (Phase 3, Needs meta-api), whose spend approval was requested from the coordinator at 13:18 UTC; Phase 6 stays parked on the operator's live run of D09 T01 §1.
