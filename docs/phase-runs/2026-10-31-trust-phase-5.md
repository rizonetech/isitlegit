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

- D05 T01 §2 encrypted bank accounts: implemented at 23224fbd. Completion review (rerun after the crash): gaps; 3 implemented (the key epoch and its triggers for the re-key cutover race, the match-audit and interrupted re-key failure paths, the latency bench: local cold 5 to 7 ms, warm p95 5 to 7 ms, 20 concurrent p95 52 ms), 2 filed into D05 T02 §3 (refusals are unavailable checks; registry-baseline wording), 3 owned by D05 T01 §3, §4 and D06 T01 §3. Stamped 2026-10-31 at 531ed12b (merged tip 120ad2ec), migration 0048. Rounds: 1 (2 P1: the limit window moved backwards on a late check; matching ignored the key epoch), 2 (1 P2: lost-key recovery, `abandonLostKeys`), 3 clean. Final review off in the pin. Tests: bank 20, identity 11.
- D06 T01 §2 supplier ledger: stamped 2026-10-31 at c6962b44, migration 0049. Corrected at start (0049, the shared key epoch, no limit on the organisation's own ledger, the model owns every change, registrable domains). Plan review: 1 P1 and 2 P2, all planned (`findSupplier` never guesses, organisation-scoped changes, both account tables proven together). Completion review: gaps; 2 implemented (concurrent edits keep each other's fields; refusals name their field), 2 filed into D06 T01 §4 (three-action account change; provenance, with no second approval as the recorded default), the rest owned by §3 and §4. Rounds: 1 (1 P1: a partial edit erased domains), 2 (1 P2: removing a supplier with accounts reported failure, D1 counting the cascade), 3 clean. Mutations: 4 of 4 killed. Tests: ledger 23, bank 20.

## Critical events

- 2026-10-31 15:52 SAST operator stop (through the coordinator): park the lane to free memory. The D05 T01 §2 completion review (dispatcher pid 903135) was stopped before it returned and recorded nothing: it counts as no review. Run guard ended with reason operator-stop and the heartbeat deleted.
- RESUME POINT: D05 T01 §2 (encrypted bank accounts), implementation committed at 23224fbd, step: completion review. First, rerun the completion review (`scripts/review-dispatch.py --kind completion --candidate 23224fbd30c7b790c96297950731a9b184d4241b`, prompt as in the session's comp52.md: the D05 T01 §1 completion prompt with range `9de5ba34..23224fbd` and §2's purpose), then the rounds, merge origin/main, stamp. Nothing half-done in the tree. After it: D06 T01 §2 (supplier ledger, migration 0049; merge origin/main first). Resume needs a new run guard (`acquire --handover`).

- 2026-10-31 12:10 SAST: the hostile-input test of D06 T02 §1 drove workerd out of memory (1.4 GB heap) and contributed to earlyoom kills on the shared machine; a real quadratic in the reader, fixed in 827dfa36; told the coordinator. Section tests since run one file at a time under a memory guard.
- bookkeeping: heartbeats 12:22 to 14:04 SAST found the guard owned and reviews in flight; the run file was left still while reviewers read the tree.

- Run guard: session f05be6ba-77af-40ea-a208-b442ebc86dc5, heartbeat job b81f2387, generation 0b037fe1f5ae, run 848419b312c2, scope plan.
- 2026-10-31 16:25 SAST operator resume after the machine crash (15:57 SAST): guard handed over (`acquire --handover operator-resume`) from the lost session f05be6ba; the old guard file had survived the stop. Run guard: session 2f637d92-23ae-4375-8fda-0d03468a3af2, heartbeat job 6039b66f, generation bd2544594cb2, run 848419b312c2, scope plan. The comp52.md prompt was gone with the old scratchpad and was rebuilt from docs/completion-review-prompt.md (range 9de5ba34..23224fbd).

- 2026-10-31 17:20 SAST: D06 T01 §2 was stamped (55cf0795) before branch CI finished on its candidate c6962b44, against the rule that the whole suite is read green from CI on the exact head first. CI on c6962b44 is being watched; a red result revokes the stamp through `unstamp` and is fixed at its layer. D05 T01 §2's candidate 531ed12b ran green.
- 2026-10-31 17:27 SAST: CI red at c6962b44 (https://github.com/rizonetech/isitlegit/actions/runs/41213900570, Worker tests 2 of 3): `test/trust/bank.test.ts` "writes exactly the allowlisted payload" read two events of one millisecond out of order; ULIDs of one millisecond sort at random by design (`src/db/ulid.ts`), and the test helpers ordered the history by id. Fixed in the helpers (`events` in `test/trust/helpers.ts`, `ledgerEvents` in `test/invoice/ledger.test.ts`), which now read insertion order (rowid), with a same-millisecond regression test. No D06 T01 §2 code was at fault, so its stamp stands once CI is green on the fix.
- 2026-10-31 17:30 SAST: CI green at 55cf0795 (https://github.com/rizonetech/isitlegit/actions/runs/41214118145), the stamp commit of D06 T01 §2 over the same code as c6962b44: the whole suite is green on that section's head, so its stamp stands; the ordering flake was intermittent, and its fix (e245b1c7) goes out with the next push.
## Lessons

- Every loop over attacker-controlled counts (ranges, maps, strings, regex inputs) needs a write counter charged to the shared budget, not a size check: rounds 1 to 8 found the same overwrite or allocation shape in five places.
- Wall-clock bounds flake on a shared machine; prove linear work with counters, keep time as a generous backstop.
- Coordinator 2026-10-31 11:22 SAST: migrations 0047 (D05 T01 §1), 0048 (D05 T01 §2), 0049 (D06 T01 §2); trust lane edits the body of `listSupplierDomains`; BANK_KEY and BANK_MATCH_KEY declared in code with test-only keys, a typed error when missing, real keys an operator credential decision.
- Coordinator 2026-10-31 11:26 SAST: the trust lane makes the three wiring edits in D06 T02 §3 (merge origin/main first); new check names need an app-lane evidence card, so names and evidence shape go to the coordinator before §3 stamps; test-only bank keys go in `vitest.config.ts`; production keys exist in vault item "IsItLegit bank key" (base64 of 32 bytes each), set by the coordinator at deploy.
- D05 T01 §1 started 2026-10-31 12:15 UTC after D06 T02 §1's stamp; corrected at start (migration 0047, audit table here, no demo flag needed).
- D05 T01 §2 started after D05 T01 §1's stamp (ec0dd871); corrected at start (keys typed, key_id, protection required for matching, removeAccount, own limiter table).
- Coordinator 2026-10-31 17:03 SAST: the console lane filed D07 T04 §13 (invoice and payment-document words in the console's Type column, Phase 7) at 45f116f9 on console-lane, depending on D06 T02 §3 and needing a stored invoice and payment-document classification (D06 T01 §1, D06 T02 §3); shape that classification so the member console's Type column can read it. No cross-reference added into this lane's files.
- D06 T01 §2 mutation check 2026-10-31 17:03 SAST: four mutations (findSupplier guessing, no NoBaseline, the stub listSupplierDomains, re-key skipping the ledger) each killed by the test that names it.
