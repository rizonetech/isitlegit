# Phase run: Phase 4 again, the walkthrough lane

Started 2026-10-31 17:42 UTC by `process-plan`, scope plan, on branch `walkthrough-lane`, continuing `docs/phase-runs/2026-10-31-walkthrough-phase-4.md` after the crash recovery: that file's run (`b9817566e0bf`) carries the coordinator's crash-time PARKED line, so the resumed run takes this file and a fresh run id. Shipped since the resume: D04 T02 §3 (stamp 1676ed88) and D04 T02 §4 (stamp 5cc949db), both recorded in the earlier file.

## Sections

- D04 T02 §5 form target and evidence chain: started at validation and stopped before `Started:`: the walkthrough's items have no way into a case's evidence (`saveEvidence` replaces a case's whole list and only the `checks` step calls it; no later producer exists). Filed D02 T01 §5 (evidence added by later pipeline steps) for the checks lane, which owns the evidence core, in be4ccc57; §5 now depends on it. Also noted for §5 when it starts: NimbusMail is not in `data/brands.json` and logo matching (D03 T03 §3, §4) is not built, so `walkthrough.credential_target` needs a stated default for "the brand's domain" (the lookalike evidence's brand, else no brand known); the report has no `walkthrough` card family yet (D07 T03 §13, app lane).

## Waiting

Every open row of the lane waits on another lane's row:

- D04 T02 §5 on D02 T01 §5 (filed today; the walkthrough lane builds it, coordinator 19:41 SAST).
- D04 T02 §1 and §7 on D02 T07 §2 (checks lane).
- D04 T02 §6 on D04 T02 §5 and D02 T07 §3 (checks lane).
- D03 T03 §1 on D03 T02 §1 (glimmer lane); §3 and §4 follow §1.

## Critical events

- 2026-10-31T17:42Z run guard re-pointed to this file: session 5e443bb6-3e90-45b1-97a3-fa3f49be8df5, heartbeat job b78914ca (replacing 62e58683), generation dd5c80e0a4b6, run e7e93bd428ee, scope plan, lane walkthrough.
- 2026-10-31T17:43Z coordinator (19:41 SAST): the walkthrough lane takes D02 T01 §5 (listed in `todo/lanes.json`, approved), migration 0057 (`evidence.producer`, nullable ADD COLUMN, readers default null to the checks' producer, a migration test that existing rows are untouched); saveEvidence deletes only the checks' rows, addEvidence replaces only its own producer's rows; the checks lane (isitlegit-3d) told before the change. Live runs held until the Meta day cap resets at 00:00 SAST.
- 2026-10-31T17:45Z wake: READY D02 T01 §5; wake: merge conflict in todo/lanes.json: backed out; the coordinator resolves it (main added D03 T03 §5 to the walkthrough lane's sections where this branch added D02 T01 §5; both entries belong). main has not changed src/checks/evidence.ts, registry.ts or the evidence test, so D02 T01 §5 builds on this branch meanwhile.
- 2026-10-31T17:47Z checks lane (isitlegit-3d): its branch already holds a D02 T01 §5 ("Detection-data revision with each outcome", not on main). Renumbering this lane's section to §6 is refused by the graph here (sections run without gaps, and this branch has no §5), so it stays §5 and the coordinator renumbers one of the two at the merge (the checks lane's offer). The evidence core's Freeze check keeps `test/checks/evidence.test.ts` unchanged, so §5's tests go in a file of their own; the checks lane's D02 T01 §4 adds a trailing `revision` parameter to `saveEvidence`, untouched by `addEvidence`.
