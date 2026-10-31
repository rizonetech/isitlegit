# Phase run: Phase 6 (console lane)

Run d1b36ec3d3ab, started from process-plan after the console lane's Phase 2 closeout (docs/phase-runs/2026-10-31-console-phase-2.md, run 341ca1492bf7).

## Phase repairs

- `resolve` over the lane's Phase 6 rows (2026-10-31): exit 0 for D07 T04 §2, §3, §4, D07 T05 §1 (Needs cloudflare), D07 T08 §1, §2, §3, §4, §6; exit 4 for D07 T04 §12 (owner-decision), D07 T05 §2 (waits on D07 T05 §1), D07 T08 §5 (waits on D07 T05 §2 and D07 T03 §6), D07 T08 §7 (operator; waits on D07 T08 §1). No exit 1 or 2.

## Shipped-row verification

- D07 T04 §1 (spine of §2): stamped, receipt docs/reviews/d07-t04-s1.json; its page tests re-ran green inside D07 T04 §7's gates (test/web/cases-page.test.ts, 2026-10-31).

## Gap audit

- D07 T04 §2 against board `Cases` (2026-10-31): the uPlot chart is not on the board (struck); Money at risk caught needs flagged invoice amounts (D06 T01 §3, trust lane): filed D07 T04 §17; the kinds line under Malicious or suspicious needs a case kind nobody stores or defines: filed D07 T04 §18 (owner-decision). Both listed in the console lane.

## Sections

- D07 T04 §2: corrected against the board (6ac31cfe: chart struck, §17 money at risk and §18 threat kinds filed); plan review astra 4xP2, all planned (af717c74) and built (6f024a52: stats panel, CSV, the report's /cases/:caseId constrained to a ULID with the coordinator's approval, app lane told); completion review: org-bound export and page refusals built (ae8af01c), 10,000 cases measured (5 ms week, 36 ms CSV), §19 and §20 filed (owner decisions); round 1 (medium) clean, HIGHEST none. Gates: worker 36/36 (stats, cases page), 77/77 earlier with report-access; Chromium 27/27.

## Critical events

- 2026-10-31 guard re-pointed: session 8962aad5-595e-41c2-bdae-0e68ae7a5dcb, heartbeat job b261f2f2, generation cfe32c51caac, run d1b36ec3d3ab, scope plan; old job ea31d2e4 deleted.
- bookkeeping: heartbeat resumed 2026-10-31T16:01Z
- bookkeeping: heartbeat resumed 2026-10-31T16:08Z

- D07 T04 §2 stamped in c14e7276 (CI run 41218199560 green at 57a9c9fa); origin/main merged at 8356eadc.
- Open with the app lane: its checkerSql fix to src/db/case-list.ts (on app-lane, not yet on main) overlaps §7's uploader rules; agreed to fold "Former member" and the blank-name email into the shared read, `Checker = { kind: "member"; name } | { kind: "former" } | null`, on console-lane once it reaches main.

## Lessons
