# Phase run: trust lane, Phase 5 (2026-10-31)

## Phase repairs

- Audit 2026-10-31 11:20 SAST: `validate` reads valid, 330 sections; lane `trust` (D05, D06); `plan --check` current.
- Ready rows: 3 in Phase 5 (D05 T01 §1, D06 T01 §2, D06 T02 §1); all exit 0 on `resolve`.
- Blocked rows: 19 in Phase 5, 30 in the lane; cross-lane prerequisites still open: D03 T02 §2 and D03 T03 §3 (exit 4); `meta-api` Needs on D05 T02 §2, D06 T01 §1, D06 T02 §2 and §4; `cloudflare` on D05 T03 §2.
- Phase 5 starts first: it is the lane's only phase with ready rows.
- Migration numbers in the plan (0010, 0011, 0014) are stale: the tree is at 0045. Asked the coordinator for three numbers 2026-10-31 11:24 SAST; D06 T02 §1 (no migration) runs first while waiting.

## Shipped-row verification

- Spine: D07 T02 §5 and D07 T02 §3 resolve exit 3 (verified).

## Gap audit

## Sections

## Critical events

- Run guard: session f05be6ba-77af-40ea-a208-b442ebc86dc5, heartbeat job b81f2387, generation 0b037fe1f5ae, run 848419b312c2, scope plan.

## Lessons
- Coordinator 2026-10-31 11:22 SAST: migrations 0047 (D05 T01 §1), 0048 (D05 T01 §2), 0049 (D06 T01 §2); trust lane edits the body of `listSupplierDomains`; BANK_KEY and BANK_MATCH_KEY declared in code with test-only keys, a typed error when missing, real keys an operator credential decision.
- Coordinator 2026-10-31 11:26 SAST: the trust lane makes the three wiring edits in D06 T02 §3 (merge origin/main first); new check names need an app-lane evidence card, so names and evidence shape go to the coordinator before §3 stamps; test-only bank keys go in `vitest.config.ts`; production keys exist in vault item "IsItLegit bank key" (base64 of 32 bytes each), set by the coordinator at deploy.
