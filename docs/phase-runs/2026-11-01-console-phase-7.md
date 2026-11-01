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
