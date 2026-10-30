# Four lanes: two building lanes, Glimmer, and a coordinator

Decided with the operator on 2026-10-30 (brainstorm after the Phase 2 stop). This replaces the two-lane cadence (main plus Glimmer) for the rest of the plan.

## Why split by domain, not by phase

Phases are an ordering, not separate work. On 2026-10-30 the open rows of Phases 2, 4 and 6 (100 rows) and of Phases 3, 5 and 7 (64 rows) shared 22 open dependencies in both directions (13 one way, 9 the other), so a split by phase would leave each lane waiting on the other. A split by domain, balanced by row count, shares 7.

## The lanes

| Lane | Worktree | Branch | Owns | Open rows |
| ---- | -------- | ------ | ---- | --------- |
| Coordinator | `~/isitlegit-main` | `main` | `main`, merges, CI, deploys, D00 and D99, shared tooling, the review pin, hooks, migration numbers, the machine, manual and operator work | D00, D99 |
| Checks lane | `~/isitlegit` | `checks-lane` | D01 intake, D02 checks, D04 agent, D08 eval, D09 launch | 70 |
| App lane | `~/isitlegit-app` | `app-lane` | D05 trust, D06 invoice, D07 app | 75 |
| Glimmer | `~/isitlegit-glimmer` | `glimmer-screener` | D03 vision | 22 |

Each building lane works its own domains in phase order, through `process-plan` scoped to them (below). The coordinator builds no product section, so its merges and checks stay neutral.

## How the lanes meet

- **Main is the coordinator's.** A building lane commits and pushes only its own branch. The coordinator merges a lane into `main` at the lane's stamp boundaries, with `todo/implementation-plan.md` regenerated rather than merged (D00 T01 §22: the `todo-plan` merge driver and the `git commit --no-edit` that concludes the stopped merge; it was resolved by hand with `plan --sync` before), and runs the gates on the merge before pushing it.
- **Lanes take `main` at their own boundaries**, as Glimmer does now, and tell the coordinator when they have.
- **Cross-lane work is asked for, not done.** A lane that needs a row another lane owns sends it a message; it never edits that lane's TODO, source or tests. XREF lines in a TODO file the other lane owns go through that lane.
- **Shared tooling is the coordinator's**: `scripts/`, `.conclave/reviewers.toml`, `scripts/hooks/`, `.claude/`. A building lane that finds a tooling gap reports it; the coordinator files and builds it.
- **Migration numbers are handed out by the coordinator** before a lane writes one, so two lanes never both write the next number.
- **Every stamp is announced** to the coordinator, with the commit and anything the other lanes must know.

## The machine

10 cores and 17 GB of memory; `/tmp` is memory-backed (8.8 GB) and earlyoom has already stopped one Glimmer build.

- Cores: Glimmer's long runs keep their own; each building lane pins its tests to two cores of its own (checks lane `taskset -c 6,7`, app lane `taskset -c 8,9`); the coordinator uses what is left, lightly.
- One whole Worker suite at a time across the machine, under a lock the coordinator provides; a lane runs only its targeted tests otherwise.
- Tests remove every folder they make; the coordinator sweeps `/tmp` of test leftovers older than an hour and reports what it removed.

## Reviews

The review schedule stays as it is. Limits are not a constraint for now (the operator has a reset and 65,000 credits in hand, 2026-10-30): the coordinator only notes usage at its boundaries and tells the operator if a limit comes close.

## Manual work

The coordinator owns the operator rows (Phase 1) and the rows whose Needs name `meta-api`, `live-mail`, `whatsapp` or `attended`: it prepares each one to the step only the operator can take, and asks for that step alone.

## Before the second building lane starts

The tools see every row: `query ready`, the run guard's stop hook and the heartbeat would each have one lane block on, and resume, the other lane's rows. Lane scoping (a lane's domains named once, honoured by `query ready`, the stop hook, the heartbeat and `process-plan`) is the coordinator's first section, D00 T01 §19. Until it lands, only one building lane runs `process-plan`.

## Amendment, 2026-10-30: a fifth lane, `media`, registered but not coordinated

Operator request, 2026-10-30. A fifth lane, `media`, makes promo and explainer videos for the IsItLegit YouTube channel (@DerickPayneDev) with Remotion: first "How IsItLegit is built" (the development method, including the final review through Muse Code) and "IsItLegit in 60 seconds" (the tech stack). It is not the demo video: D09 T02 §4 and D99 T02 §3 to §5 stay as they are.

| Lane | Branch | Worktree | Owns |
| ---- | ------ | -------- | ---- |
| Media | `claude/trusting-pasteur-umwvqz` | a Claude Code cloud session | D10 `10-media`, and `media/` |

The coordinator registers the lane and does not run it:

- Its rows never appear in another lane's `query ready`, `blocked` or `stats`: `todo/lanes.json` gives it D10, and every lane counts only its own domains (D00 T01 §19).
- It runs no `process-plan`, and no run guard or heartbeat blocks on or resumes its rows.
- Its stamps need no plan review, completion review or review rounds, only the commit and the checks that ran.
- It merges into `main` only when the operator asks, never at its stamps. Until then its rows and files stay on its branch.
- It touches only `media/` and `todo/10-media/`, never `scripts/`, `.claude/`, `.conclave/`, `todo/lanes.json` or another domain, and it never calls the Meta Model API.
- `media/` is self-contained: its own `package.json`, its own `pnpm-workspace.yaml` (so pnpm, looking upward, stops there and keeps `media/pnpm-lock.yaml` apart from the root lockfile), outside the root workspace's `packages` list. The root gates do not read it: Biome, TypeScript and Vitest include named folders only. Remotion's licence is checked by the lane before its first render: Remotion is free for individuals and companies of up to three people, and needs a company licence above that.

The first rule holds today through the lane scoping. The rest are enforced in the tools by D00 T01 §26 (an uncoordinated lane): a `"coordinated": false` key in `todo/lanes.json`, a run guard that refuses to start a run in such a lane, and a stamp that records the waived reviews in the receipt.

## Order of the switch

1. File D00 T01 §19 (lane scoping) and this note on `main`.
2. Move the existing worktree `~/isitlegit` (the session that built Phases 0 to 2 so far) onto `checks-lane`, created from `main`; it continues D02 T02 §1. Add the worktree `~/isitlegit-main` on `main` for the coordinator, with its own `pnpm install`.
3. Start the coordinator session in `~/isitlegit-main`; it builds §19 first.
4. Create `app-lane` and its worktree once §19 is on `main`, and start the app lane's session.
5. Tell the Glimmer lane: it now merges into `main` through the coordinator, and asks the coordinator, not main's building session, for tooling.
