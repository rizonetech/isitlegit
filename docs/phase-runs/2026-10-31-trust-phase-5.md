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

- D06 T02 §1 PDF forensics: stamped 2026-10-31 at 140d07c1 (merged tip 9a82bc3b). Plan review: 5 P1 and 5 P2, all planned. Completion review: gaps; 12 implemented, 3 filed (D06 T02 §3, D06 T02 §5, D08 T02 §6). Rounds: 1 (5 P1, 3 P2), 2 (2 P1), 3 (1 P1), 4 (1 P1), 5 (P3, fixed), 6 (1 P1), 7 (1 P1), 8 (1 P2), 9 clean. Tests: 90 across 7 files. Spark limited to fields and layout in D06 T02 §2 and D06 T01 §1 (the eval lane's D08 T03 §1).
- D05 T01 §1 protected identities: stamped 2026-10-31 at 1f7a658f (merged tip b2f04813), migration 0047. Plan review: 4 P1 and 4 P2, all planned. Completion review: gaps; 8 implemented, 2 filed (D05 T01 §2, D05 T01 §3). Rounds: 1 (2 P2), 2 (1 P2), 3 (1 P2; sanitiser rebuilt on XML namespaces after the third finding), 4 clean. Tests: identity 11, logo 22, logo-render 3 (Chromium).

- D05 T01 §2 encrypted bank accounts: implemented at 23224fbd. Completion review (rerun after the crash): gaps; 3 implemented (the key epoch and its triggers for the re-key cutover race, the match-audit and interrupted re-key failure paths, the latency bench: local cold 5 to 7 ms, warm p95 5 to 7 ms, 20 concurrent p95 52 ms), 2 filed into D05 T02 §3 (refusals are unavailable checks; registry-baseline wording), 3 owned by D05 T01 §3, §4 and D06 T01 §3. Rounds next.

## Critical events

- 2026-10-31 15:52 SAST operator stop (through the coordinator): park the lane to free memory. The D05 T01 §2 completion review (dispatcher pid 903135) was stopped before it returned and recorded nothing: it counts as no review. Run guard ended with reason operator-stop and the heartbeat deleted.
- RESUME POINT: D05 T01 §2 (encrypted bank accounts), implementation committed at 23224fbd, step: completion review. First, rerun the completion review (`scripts/review-dispatch.py --kind completion --candidate 23224fbd30c7b790c96297950731a9b184d4241b`, prompt as in the session's comp52.md: the D05 T01 §1 completion prompt with range `9de5ba34..23224fbd` and §2's purpose), then the rounds, merge origin/main, stamp. Nothing half-done in the tree. After it: D06 T01 §2 (supplier ledger, migration 0049; merge origin/main first). Resume needs a new run guard (`acquire --handover`).

- 2026-10-31 12:10 SAST: the hostile-input test of D06 T02 §1 drove workerd out of memory (1.4 GB heap) and contributed to earlyoom kills on the shared machine; a real quadratic in the reader, fixed in 827dfa36; told the coordinator. Section tests since run one file at a time under a memory guard.
- bookkeeping: heartbeats 12:22 to 14:04 SAST found the guard owned and reviews in flight; the run file was left still while reviewers read the tree.

- Run guard: session f05be6ba-77af-40ea-a208-b442ebc86dc5, heartbeat job b81f2387, generation 0b037fe1f5ae, run 848419b312c2, scope plan.
- 2026-10-31 16:25 SAST operator resume after the machine crash (15:57 SAST): guard handed over (`acquire --handover operator-resume`) from the lost session f05be6ba; the old guard file had survived the stop. Run guard: session 2f637d92-23ae-4375-8fda-0d03468a3af2, heartbeat job 6039b66f, generation bd2544594cb2, run 848419b312c2, scope plan. The comp52.md prompt was gone with the old scratchpad and was rebuilt from docs/completion-review-prompt.md (range 9de5ba34..23224fbd).

## Lessons

- Every loop over attacker-controlled counts (ranges, maps, strings, regex inputs) needs a write counter charged to the shared budget, not a size check: rounds 1 to 8 found the same overwrite or allocation shape in five places.
- Wall-clock bounds flake on a shared machine; prove linear work with counters, keep time as a generous backstop.
- Coordinator 2026-10-31 11:22 SAST: migrations 0047 (D05 T01 §1), 0048 (D05 T01 §2), 0049 (D06 T01 §2); trust lane edits the body of `listSupplierDomains`; BANK_KEY and BANK_MATCH_KEY declared in code with test-only keys, a typed error when missing, real keys an operator credential decision.
- Coordinator 2026-10-31 11:26 SAST: the trust lane makes the three wiring edits in D06 T02 §3 (merge origin/main first); new check names need an app-lane evidence card, so names and evidence shape go to the coordinator before §3 stamps; test-only bank keys go in `vitest.config.ts`; production keys exist in vault item "IsItLegit bank key" (base64 of 32 bytes each), set by the coordinator at deploy.
- D05 T01 §1 started 2026-10-31 12:15 UTC after D06 T02 §1's stamp; corrected at start (migration 0047, audit table here, no demo flag needed).
- D05 T01 §2 started after D05 T01 §1's stamp (ec0dd871); corrected at start (keys typed, key_id, protection required for matching, removeAccount, own limiter table).
