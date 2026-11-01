# Phase run: Phase 7 (console lane, Muse Code)

Started 2026-11-01 by the Muse Code console lane in `~/isitlegit-console` on `console-lane`, from the operator's handover instruction. Read in full: `AGENTS.md`, `docs/handover/2026-11-01-muse-code.md` (absent on this branch before the merge; read from `origin/main` after it), `docs/coordinator.md`, and the final Resume point (handover to Muse Code) in `docs/phase-runs/2026-10-31-console-phase-6.md`.

## Setup

- First action after reading in: replied to coordinator session `canvas-coma` with `SEQ-CONSOLE-OK console-lane 3726d247` (the short HEAD at that moment).
- Merged `origin/main` into `console-lane` (a merge, never a rebase or force-push): it fast-forwarded to `0599820d`, because every console stamp was already on `main`. No conflicts.
- `query lane` says `console`. `query ready` for this lane: D07 T05 §1, D07 T04 §5, D07 T04 §6, D07 T04 §16, D07 T04 §28, in that order.
- Machine: tests pinned to `taskset -c 8,9`, one heavy job at a time, each Worker test file on its own; `free -m` checked before heavy runs.

## Conflicts recorded (later dated instruction wins)

- The handover section 4 and `AGENTS.md` say Muse Code needs a `--writer muse` route added before its first review; `origin/main` already carries it (`f753fc8b`, tooling: add the muse writer route, reviewed by Astra), and this lane's instruction says reviews run with `--writer muse` (Astra). That wins over the `process-todo-section` skill's `--writer claude` example.
- `docs/coordinator.md` (2026-11-01 11:35 SAST) records the operator approving D07 T05 §1's Access application; the later Resume point (2026-11-01 13:06 SAST) records that Zero Trust is not enabled on the account, so §1 still waits on the operator enabling Zero Trust and giving the team name. The later record wins: §1 is not started.
- Deferred until after the competition (operator, through the coordinator): D07 T04 §8, §9, §10, §11, §12, §15, §18, §19, §20, §22, §23, §26 and D07 T08 §7. Not started. D07 T04 §5 and §6 have no board; D07 T04 §16 needs an attended run. None started.

## Next section

D07 T04 §28 (Verifier's name on the Domains page). Its wait on the app lane's D07 T02 §24 is cleared: §24 is Verified on `main` (exit 3 from `resolve`), migration 0058 is deployed, and `GET /api/org/domains` serves `verifiedBy` (`src/auth/domains.ts`).

## D07 T04 §28 stamped (2026-11-01)

- Plan review (Astra, `--writer muse`): 2 P2 gaps, both planned in 3fa5ccdb. The page cannot read through `GET /api/org/domains` for ordinary members (it refuses them at `src/auth/domains.ts:597`), so `readClaims` selects the verifier through the shared organisation-scoped `verifierSql` and `verifiedByOf`, now exported from `src/auth/domains.ts` (two lines; the app lane is told). The browser test now asserts the visible wording per row, width and theme.
- Built in fe2e1a6f: `byline` in `src/web/pages/domains-list-view.tsx` (named member abbreviated, unnamed member by email local part, former member, none), drawn in the domain proved cell and the single-address wording; the SPEC M8 Deviation now keeps only the admin@/postmaster@ part. Completion review: one in-scope gap (each row's verifier proven on its own, with different verifiers) implemented in 8eb8c1e2; the out-of-scope detail view filed as D07 T04 §29 (owner-decision first). Round 1 clean (`HIGHEST: none`). Final review is off in the pin.
- Gates: `test/web/domains-list.test.ts` 24 passed (3 failed before the build), `test/auth/domains.test.ts` 46 passed, browser `domains-list` 9 passed and `addresses` 15 passed, `check-design.py` 0 problems, typecheck clean, Biome clean on the touched files. `pnpm lint` over the whole tree still reports errors in other lanes' files on `main` (`scripts/glimmer/`, `src/checks/instruction-phrases.ts`, and others this lane did not touch); none is in a file §28 changed.
- Stamped on 8eb8c1e2b6df979d9184c68dd5fee7ccff3ebfed; receipt `docs/reviews/d07-t04-s28.json`.

Nothing else in this lane is runnable now: D07 T05 §1 waits on the operator enabling Zero Trust, D07 T04 §5 and §6 have no board, D07 T04 §16 needs an attended run, D07 T04 §29 waits on its owner decision, and the deferred rows stay deferred.
