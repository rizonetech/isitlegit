# Codex coordinator and lanes

The operator selected Codex on 4 November 2026. The current lane assignments are in `todo/lanes.json`; the coordinator stays on `main`. Each lane keeps its existing branch, worktree, backlog and handover files. Codex writes under the explicitly enabled `codex-two-pass-v1` policy (operator REVIEW-18): sound-plan self-review, implementation and tests, one combined quality and completion self-review, stamp, then the next ready section. The combined review proves every agreed requirement is completed and correctly implemented, covering adversarial, integration, source-defect, plan-delivery, consistency, record, quality and optimization checks, plus design for an actual `Surface: yes` section. There is no third normal review. Follow `.agents/skills/codex-lane-workflow/SKILL.md` for the exact review and stamp commands. Historic reviews keep their original policy. A legacy plan with no round or completion attempts can transition explicitly with `--transition-plan`; preserve its original digest, candidate and pin. A two-pass stamp has no `--review` argument. Existing three-pass chains retain their real rounds. Completion gaps require the one bounded reconciliation route, never invented approval. Recover an unrecorded combined result with `--recover-completion --record <findings-path>` and an unrecorded reconciliation with `--recover-reconciliation --record <findings-path>`; both replay the same persisted response without a new reviewer call. Preserve unresolved call markers and continue independent work while a genuine recovery blocker remains.

## Delivery authority and deadline

The coordinator has standing authority to raise project caps and approve additional project spend, resolve decisions, change priorities and reassign work toward the corrected **5 November 2026, 00:00 SAST (4 November 22:00 UTC)** completion/polish target and **5 November 2026, 04:00 SAST (02:00 UTC)** actual deadline (operator correction BRAIN-20261104-DEADLINE-02). These replace the earlier 16:21 SAST target and do not restart with a session. AGENTS.md's Coordinator delivery authority is the governing record, including the requirement to change caps at their owning layer, preserve accounting and record the decision. Every lane follows those decisions over earlier project preferences. Later user instructions and stop requests still prevail; the product safety contract and evidence gates remain mandatory. This setup grants authority; it does not itself increase any spending limit or start a project run.

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

The operator requires unattended sessions from 4 November 2026: no blocking questions. Take authorized decisions, record assumptions and reversal costs, and continue independent ready work when one item is blocked. The launcher alone does not establish continuation coverage; the native hooks and host heartbeat below require separate verification. The old Muse cron and Claude Stop hook do not become Codex jobs because their instructions are present in the repository. Do not record `lane heartbeat installed:` without a real native job and its verified ID.

While the coordinator is active, it checks handovers at section boundaries and wakes waiting sessions explicitly. If this Codex environment exposes a native recurring job tool, the session may install and verify its own idle-only heartbeat, record its ID, and cancel it when its run closes. Otherwise retain a clear Resume point and use the exact-session resume command when continuation is needed. Never acquire a campaign guard with a fabricated heartbeat ID, take another writer's guard or claim unattended coverage from a launcher dry run.

Only the coordinator merges lanes into main, using the existing CI gate. Lanes retain their assigned test cores, targeted test scope, product safety contract, synthetic-data requirement and publication checks. A tool failure or unresolved review finding is a blocker to stamping, not an approval.

## Guarded unattended continuation

The owning implementation is `scripts/codex_continuation.py`, the native local protocol client is `scripts/codex_rpc.py`, and the project lifecycle definitions are `.codex/hooks.json`. The launcher reserves the lane before starting Codex. A second launch refuses while that reservation exists. An existing owner resumes by exact session UUID; a paused owner requires explicit activation first. Direct Codex launches outside this entrypoint are not covered by its launch reservation.

The session activates its reservation using the claim printed in its launch prompt and its actual session ID:

```bash
python3 scripts/codex_continuation.py activate --lane checks --session SESSION_UUID --claim CLAIM_UUID
python3 scripts/codex_continuation.py status
```

Activation verifies the native thread's worktree and all five loaded project hooks' enabled/trusted state. It does not edit the runtime's trust records. Review the exact `.codex/hooks.json` definitions in Codex's `/hooks` screen, trust them, and reload/resume the session so `hooks/list` for that thread reports them. This is a native runtime trust step, not a permission question to ask repeatedly. If it is unavailable during an unattended run, record the physical operator action once and keep runtime readiness incomplete. Never use `--dangerously-bypass-hook-trust` as a substitute. Tool hooks are a guardrail, not a security sandbox; the runtime's own turn serialization and review sandbox remain authoritative.

The owner runs the following before acknowledging a conversational stop or finishing its authorized run. An actual native Interrupt invokes the pause behavior automatically. A paused or completed record survives process/timer restarts and never silently reactivates.

```bash
python3 scripts/codex_continuation.py pause --lane checks --session SESSION_UUID
python3 scripts/codex_continuation.py complete --lane checks --session SESSION_UUID
```

`release --lane checks` removes a reservation only after the owner is paused/completed and the native thread is idle/not loaded (or an unbound launch process is gone). It cancels only the outstanding heartbeat queue item, never user messages. An authorized new activation advances the generation. An outstanding old-generation wake is refused, even if its queue message arrives late.

WORKAROUND: the installed Codex runtime has no exposed native recurring scheduler. The coordinator installs one user-systemd host timer for this project. It inspects native thread status and wakes only registered idle owners with observed lifecycle events and a cleared wait. It never fabricates a native cron ID or acquires the Claude campaign guard. The timer's installed identity is `isitlegit-codex-heartbeat.timer`, with a five-minute cadence and a separate `isitlegit-codex-heartbeat.service` invocation. It runs only while this user's systemd manager and WSL host are running; it cannot wake a powered-off computer.

```bash
python3 scripts/codex_continuation.py install-timer
systemctl --user status isitlegit-codex-heartbeat.timer
python3 scripts/codex_continuation.py status
python3 scripts/codex_continuation.py remove-timer
```

State and the latest observed timer tick live in `~/isitlegit-data/handover/codex-continuation/`. `heartbeat.json` is an observation, not proof that a model resumed. The owner record's `observed` events prove hook execution and `last_ack` correlates a wake UUID to the receiving turn. A queued submission is pending until that acknowledgment; ambiguous failures are not blindly retried, and a ten-minute outstanding wake stalls visibly. Test state can be isolated with `ISITLEGIT_CONTINUATION_DIR`; production handovers use the default directory.

Waits are read from the owner's outbox, which must be updated after activation. `none` allows continuation; timezone-aware elapsed time waits and exact stamps in published `origin/main` clear automatically. The coordinator refreshes `origin/main` at merge boundaries. Operator and unknown waits stay parked. After verifying a coordinator-gate dependency, the coordinator may run `release-wait --lane checks --wait 'coordinator gate for D00 T01 §34'` for that exact wait. Three unchanged Stop continuations become a visible stall. Explicit completion disables all further automatic work.

Runtime acceptance remains incomplete until each intended session records trusted Stop and Interrupt execution, a real timer tick and a correlated resumed turn. Code tests or an enabled timer cannot substitute for those observations. D00 T01 §34 remains unstamped while any of those checks is missing. Rollback pauses owners, removes this project's timer with `remove-timer`, and removes its hook configuration; it leaves other projects, training and rendering processes alone.

## Accessible warnings

Operator direction BRAIN-20261104-WARNINGS-05 (4 November 2026): F2 opens the warning panel. At safe boundaries inspect warnings available through the owning session, tool output or supported diagnostics. Fix actionable causes in the owning layer; never suppress warnings to appear healthy. Escalate shared runtime, hook, infrastructure and cross-lane causes to the coordinator with redacted evidence. Native errors and daemon logs do not establish complete F2 panel visibility; explicitly record any inaccessible panel state. This is an operating instruction, not proof of an installed automatic warning monitor.
