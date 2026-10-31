# Phase run: Phase 4 again, the walkthrough lane

Started 2026-10-31 17:42 UTC by `process-plan`, scope plan, on branch `walkthrough-lane`, continuing `docs/phase-runs/2026-10-31-walkthrough-phase-4.md` after the crash recovery: that file's run (`b9817566e0bf`) carries the coordinator's crash-time PARKED line, so the resumed run takes this file and a fresh run id. Shipped since the resume: D04 T02 §3 (stamp 1676ed88) and D04 T02 §4 (stamp 5cc949db), both recorded in the earlier file.

## Sections

- D04 T02 §5 form target and evidence chain: started at validation and stopped before `Started:`: the walkthrough's items have no way into a case's evidence (`saveEvidence` replaces a case's whole list and only the `checks` step calls it; no later producer exists). Filed D02 T01 §5 (evidence added by later pipeline steps) for the checks lane, which owns the evidence core, in be4ccc57; §5 now depends on it. Also noted for §5 when it starts: NimbusMail is not in `data/brands.json` and logo matching (D03 T03 §3, §4) is not built, so `walkthrough.credential_target` needs a stated default for "the brand's domain" (the lookalike evidence's brand, else no brand known); the report has no `walkthrough` card family yet (D07 T03 §13, app lane).

## Waiting

Every open row of the lane waits on another lane's row:

- D04 T02 §5 on D02 T01 §5 (checks lane, filed today).
- D04 T02 §1 and §7 on D02 T07 §2 (checks lane).
- D04 T02 §6 on D04 T02 §5 and D02 T07 §3 (checks lane).
- D03 T03 §1 on D03 T02 §1 (glimmer lane); §3 and §4 follow §1.

## Critical events

- 2026-10-31T17:42Z run guard re-pointed to this file: session 5e443bb6-3e90-45b1-97a3-fa3f49be8df5, heartbeat job b78914ca (replacing 62e58683), generation dd5c80e0a4b6, run e7e93bd428ee, scope plan, lane walkthrough.
- 2026-10-31T17:43Z coordinator (19:41 SAST): the walkthrough lane takes D02 T01 §5 (listed in `todo/lanes.json`, approved), migration 0057 (`evidence.producer`, nullable ADD COLUMN, readers default null to the checks' producer, a migration test that existing rows are untouched); saveEvidence deletes only the checks' rows, addEvidence replaces only its own producer's rows; the checks lane (isitlegit-3d) told before the change. Live runs held until the Meta day cap resets at 00:00 SAST.
