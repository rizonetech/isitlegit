# Codex coordinator and lanes

The operator selected Codex on 4 November 2026. The current lane assignments are in `todo/lanes.json`; the coordinator stays on `main`. Each lane keeps its existing branch, worktree, backlog and handover files. Codex writes and uses the explicitly enabled self-review policy: plan self-review, implementation, one implementation self-review round, final completion review, stamp, then the next ready section. Follow `.agents/skills/codex-lane-workflow/SKILL.md` for the exact review and stamp commands. Historic reviews keep their original policy.

## Start the coordinator and lanes

Run this from the coordinator checkout to inspect readiness without starting agents or changing files:

```bash
python3 scripts/codex-lanes.py list
```

At an idle boundary, each lane may cherry-pick the coordinator's reviewed setup-only commit without merging unrelated main work. This is the coordinator-authorized tooling handover. Run `cd ~/isitlegit-checks && git cherry-pick SETUP_SHA && python3 scripts/codex-lanes.py launch checks --handover`, replacing the path, lane and `SETUP_SHA` with the actual setup commit for each lane. `&&` prevents launch if the cherry-pick fails. Never reset or discard dirty work to make it pass. After the setup files are integrated into each lane, open one terminal per session and run the commands below. `--handover` accepts unfinished edits from the previous idle writer without changing or discarding them; it never overrides a campaign guard:

```bash
python3 ~/isitlegit-main/scripts/codex-lanes.py launch main --handover
python3 ~/isitlegit-main/scripts/codex-lanes.py launch checks --handover
python3 ~/isitlegit-main/scripts/codex-lanes.py launch app --handover
python3 ~/isitlegit-main/scripts/codex-lanes.py launch console --handover
python3 ~/isitlegit-main/scripts/codex-lanes.py launch eval --handover
python3 ~/isitlegit-main/scripts/codex-lanes.py launch loupe --handover
python3 ~/isitlegit-main/scripts/codex-lanes.py launch media --handover
```

These are separate terminal commands, one per terminal. Do not paste them as a sequence in one terminal. The launcher uses the configured Codex model and explicitly passes `--dangerously-bypass-approvals-and-sandbox`, as requested by the operator. This disables permission prompts and the sandbox for the writing session; it does not bypass hook trust or change the review dispatcher's read-only review mode. It runs in the existing worktree, clears an inherited `TODO_LANE` override and gives the session its role and workflow. It never creates a second worktree, changes branches, commits, fetches, merges or starts other lanes. Add `--dry-run` to inspect the exact launch arguments without starting Codex.

A fresh launch requires the expected branch and the same workflow instructions, review dispatcher, stamp validator and pin as the coordinator. Without `--handover`, it also requires a clean worktree. A lane with stale tooling must integrate the setup files first, using a reviewed setup-only commit or a safe merge at its boundary; merely changing its prompt cannot enable its stamp gate. `--handover` preserves unfinished changes and instructs Codex to inspect every dirty diff and confirm the previous writer is idle before editing. Stop the old writer before opening the replacement. An existing campaign guard must be closed or handed over through `scripts/campaign_guard.py`; the launcher never deletes one.

To resume the exact Codex session recorded in a lane's outbox, including its interrupted edits:

```bash
python3 scripts/codex-lanes.py launch checks --resume SESSION_ID
```

Use the UUID or exact session name belonging to that checkout. Resume permits dirty application files, but still checks the branch and setup files and refuses a campaign guard owned by another session. A resume argument is an explicit selection of the owner, not proof that the session is currently idle. Do not resume a session that is still writing in another terminal.

## Coordinate through durable handovers

Keep `~/isitlegit-data/handover/<lane>-inbox.md` and `<lane>-outbox.md`. The coordinator reads its existing `coordinator-outbox.md`, `system-state.md` and `operator-actions.md`. Startup prompts name these real handover files and tell the session to resume the latest dated Resume point. Each lane records its actual Codex session ID, current section, tested commit, Resume point and `WAITING:` line. Read and acknowledge urgent inbox lines before each long operation. The coordinator reads outboxes, assigns cross-lane work and owns CI and merges. It uses `python3 scripts/lane_waits.py` to inspect cleared blockers and unanswered urgent messages. That command is read-only and does not deliver messages.

The installed Codex CLI supports queueing to an exact session:

```bash
codex queue --thread SESSION_ID --message 'Read your lane inbox and continue from its Resume point.' --resume
```

Write the durable inbox message first, then queue it to the recorded session. `--resume` attempts to wake the thread; the CLI can exit successfully with a warning when that attempt fails. Verify the lane's acknowledgement or a new outbox update before marking the notification delivered. `codex agents` exposes the shared local session command center; `codex resume SESSION_ID` reopens an existing session. The flags above were checked against the installed CLI help and the [official Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference).

## Continuation and ownership

This setup launches attended terminal sessions. It does not install a daemon, recurring job or Stop hook and does not make an idle session resume automatically. The old Muse cron and Claude Stop hook do not become Codex jobs because their instructions are present in the repository. Do not record `lane heartbeat installed:` without a real native job and its verified ID.

While the coordinator is active, it checks handovers at section boundaries and wakes waiting sessions explicitly. If this Codex environment exposes a native recurring job tool, the session may install and verify its own idle-only heartbeat, record its ID, and cancel it when its run closes. Otherwise retain a clear Resume point and use the exact-session resume command when continuation is needed. Never acquire a campaign guard with a fabricated heartbeat ID, take another writer's guard or claim unattended coverage from a launcher dry run.

Only the coordinator merges lanes into main, using the existing CI gate. Lanes retain their assigned test cores, targeted test scope, product safety contract, synthetic-data requirement and publication checks. A tool failure or unresolved review finding is a blocker to stamping, not an approval.
