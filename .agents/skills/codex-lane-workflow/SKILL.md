---
name: codex-lane-workflow
description: Run IsItLegit's Codex coordinator or an assigned development lane, including plan self-review, one implementation self-review round, final completion review and verified TODO stamping.
---

# Codex lane workflow

Read `AGENTS.md`, `docs/manifesto.md`, `todo/README.md` and `docs/todo-workflow.md`. The dated Codex policy in AGENTS.md overrides historical Claude, Muse and Antigravity instructions about writers, independent reviews and round loops. Do not import their session IDs, cron IDs or tool names as if they were Codex facilities.

## Ownership and recovery

Run `git status --short`, `python3 scripts/todo-graph.py query lane`, `query ready`, `query blocked`, and `query stats`. `todo/lanes.json` owns assignments. Check the existing campaign guard and the lane's handover inbox/outbox before writing. Never take over another live writer or reset its files. Read the latest lane run record and acknowledge an unacknowledged `URGENT` inbox line before normal work. A dirty tree may be unfinished work, not permission to discard it.

Use `docs/codex-lanes.md` for launching and resuming sessions. Put dated status, exact candidate, tests, Resume point and one final `WAITING: <blocker>` line in the lane's existing outbox. Allowed blockers are `stamp <ref> on main`, `coordinator gate for <ref>`, `operator: <action>`, `time: <ISO time>` and `none`. Record the actual Codex session ID for directed messages. A queued message is delivered work only after acknowledgment, not merely because the CLI exited zero.

The main session coordinates, merges at stamp boundaries, owns shared tooling and migration numbers, runs CI gates and handles deployment. It has the delivery authority and fixed twelve-hour deadline recorded in AGENTS.md: it may raise project caps, decide tradeoffs, change priorities and reassign sections without routine operator approval. A critical-path reassignment, including to main, updates `todo/lanes.json` and establishes exclusive ownership before work starts. A lane changes only its currently claimed files/sections. Follow the coordinator's recorded decisions over earlier project preferences, while honoring later user corrections or stop requests and the safety boundaries in AGENTS.md. Ask through the coordinator for cross-lane changes. Multiple agents may work on disjoint paths during implementation; every review reads a stable candidate with all writers to that tree paused.

## Deliver one section

1. Resolve the ref with `python3 scripts/todo-graph.py resolve 'DNN TNN §N'`. Respect prerequisites, Needs and lane ownership. Validate the tree and generated plan. Read the section, its governing specs, Freeze check and Test checkpoint. Use the existing TODO authoring rules for any plan corrections.
2. Commit the plan before code. Prepare a prompt from `docs/plan-review-prompt.md`, replacing its independent-review role with Codex plan self-review and filling the real ref and full candidate SHA. Run the plan command below. Fix every in-scope plan gap before recording Started and implementing. Preserve the plan-before-build evidence the graph validates.
3. Record Started, implement at the owning layer, and prove regression tests fail before a fix and pass after it. Run the section's targeted tests on its assigned CPU cores after checking free memory. Run owed build, type, lint, publication and frozen gates. Commit the implementation, without amending a reviewed candidate.
4. Prepare `docs/review-round-prompt.md` for the actual diff and run the single round below. Inspect the actual diff, callers, failure paths and Test checkpoint. Verify findings, fix every real in-scope problem, add regression coverage, rerun affected gates and commit repairs. Record dispositions beneath an ordinary heading, not a reserved review heading. There is exactly one returned regular round; an outage can be retried.
5. Prepare the completion prompt from `docs/completion-review-prompt.md`. Identify this as Codex's final completion self-review, include the round and every repair, and require proof that the final candidate resolves each finding and meets every Done when. Run completion on the exact final implementation SHA. Stamp only on `COMPLETION: complete`; a returned review with gaps stays unstamped and records a blocker. There is no fourth pass or round loop. A failed call may be retried because it returned no review.
6. Stamp with the graph command below, quoting the section's Test checkpoint and actual gate results. Use `clean` when the round found nothing, or `fixed` when completion proves its repairs. Run `validate` and `plan --sync`, commit the receipt and projection, and confirm HEAD and status. Announce the stamp and SHA to the coordinator. Continue the next ready section within the user's requested scope.

## Review commands

Replace all angle-bracket arguments with verified values. The findings path must match the section. Write prompts to scratch. A review call has to finish before another writer changes this worktree. In Codex use its normal long-running tool session and poll for completion; Claude's `run_in_background` flag is not a Codex argument.

```bash
python3 scripts/review-dispatch.py --check-pin --json
python3 scripts/review-dispatch.py --writer codex --kind plan --candidate <plan-sha> --prompt <plan-prompt> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
python3 scripts/review-dispatch.py --writer codex --kind round --prompt <round-prompt> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
python3 scripts/review-dispatch.py --writer codex --kind completion --candidate <final-sha> --prompt <completion-prompt> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
python3 scripts/todo-graph.py stamp 'DNN TNN §N' --sha <final-sha> --plan <findings-path> --completion '<findings-path>:complete' --review '<round-number>:<findings-path>:clean' --check '<quoted checkpoint and command> -> <observed result>'
```

The pin explicitly enables Codex self-review. The dispatcher marks each pass and records the pin; stamp validates that evidence. Do not hand-author approval records, relabel old passes, switch writers mid-chain or bypass a refusal. An in-progress section under an older policy keeps its evidence; ask the coordinator to resolve any policy transition explicitly rather than manufacturing a new approval.

## Continue and wait

Work one section at a time. At boundaries check the inbox and CI, then pick the next ready section in the current wave. The coordinator follows the existing CI-gated merge procedure; a local green test is not CI or deployment proof. When dependencies block all work, publish the exact blocker and use a real session wake mechanism if available. If no verified Codex heartbeat exists, keep the run attended and report that it needs a queued resume or operator resume. Never claim a scheduled run or acquire a guard using a fabricated heartbeat. An existing guard is released or handed over only through `campaign_guard.py` with its documented ownership checks.
