---
name: codex-lane-workflow
description: Run IsItLegit's Codex coordinator or an assigned development lane, including plan self-review, combined quality and completion self-review, bounded reconciliation and verified TODO stamping.
---

# Codex lane workflow

Read `AGENTS.md`, `docs/manifesto.md`, `todo/README.md` and `docs/todo-workflow.md`. The dated Codex policy in AGENTS.md overrides historical Claude, Muse and Antigravity instructions about writers, independent reviews and round loops. Do not import their session IDs, cron IDs or tool names as if they were Codex facilities.

## Ownership and recovery

Run `git status --short`, `python3 scripts/todo-graph.py query lane`, `query ready`, `query blocked`, and `query stats`. `todo/lanes.json` owns assignments. Check the existing campaign guard and the lane's handover inbox/outbox before writing. Never take over another live writer or reset its files. Read the latest lane run record and acknowledge an unacknowledged `URGENT` inbox line before normal work. A dirty tree may be unfinished work, not permission to discard it.

Use `docs/codex-lanes.md` for launching and resuming sessions. Put dated status, exact candidate, tests, Resume point and one final `WAITING: <blocker>` line in the lane's existing outbox. Allowed blockers are `stamp <ref> on main`, `coordinator gate for <ref>`, `operator: <action>`, `time: <ISO time>` and `none`. Record the actual Codex session ID for directed messages. A queued message is delivered work only after acknowledgment, not merely because the CLI exited zero. For an actionable coordinator stamp, blocker or decision notice, write the durable inbox first. Read the current native thread status: if active, send one `turn/steer` to the freshly observed turn ID and do not also queue it; if idle, queue once with a stable client message ID. Keep routine progress in the outbox. Never interrupt a review to deliver a notice. The coordinator may retire a queued notice only after matching its exact ID and content hash to durable evidence that its work was processed; verify every other prior queue ID remains. Never discard unclassified or unread user input, and never restart a completed owner merely to deliver an old notice.

The main session coordinates, merges at stamp boundaries, owns shared tooling and migration numbers, runs CI gates and handles deployment. It has the delivery authority and corrected completion and submission deadlines recorded in AGENTS.md: it may raise project caps, decide tradeoffs, change priorities and reassign sections without routine operator approval. A critical-path reassignment, including to main, updates `todo/lanes.json` and establishes exclusive ownership before work starts. A lane changes only its currently claimed files/sections. Follow the coordinator's recorded decisions over earlier project preferences, while honoring later user corrections or stop requests and the safety boundaries in AGENTS.md. Ask through the coordinator for cross-lane changes. Multiple agents may work on disjoint paths during implementation; every review reads a stable candidate with all writers to that tree paused.

## Deliver one section

Operator correction REVIEW-18 uses `self_review_policy = "codex-two-pass-v1"`: exactly two normal reviews, a sound-plan review and a combined quality/completion review after implementation and tests. There is no normal implementation round or separate final pass. Existing three-pass history stays under its recorded policy; the explicit plan-only transition below is the narrow exception.

1. Resolve the ref with `python3 scripts/todo-graph.py resolve 'DNN TNN §N'`. Respect prerequisites, Needs and lane ownership. Validate the tree and generated plan. Read the section, its governing specs, Freeze check and Test checkpoint. Use the existing TODO authoring rules for any plan corrections.
2. Commit the plan before code. Prepare `docs/plan-review-prompt.md` as Codex plan self-review with the real ref and full candidate SHA. Run the plan command below. Fix every in-scope plan gap before recording Started and implementing. Preserve the plan-before-build evidence the graph validates.
3. Record Started, implement at the owning layer, and prove regression tests fail before a fix and pass after it. Run the section's targeted tests on its assigned CPU cores after checking free memory. Run owed build, type, lint, publication and frozen gates. Commit the implementation without amending a reviewed candidate.
4. Prepare `docs/completion-review-prompt.md` for the exact candidate and run the combined completion command below. It must verify quality and that every agreed requirement is completed and correctly implemented, not merely count passing tests. The pinned schedule covers adversarial, integration, source-defect, plan-delivery, consistency, record, quality and optimization, with design when the actual section has `Surface: yes`. Verify the complete diff, callers, failure paths, every Done when and frozen obligation. Genuine additional suggestions are separate from blocking approved requirements, safety breaches, real in-scope defects and regressions. A returned gaps verdict remains unstamped; prove repairs through the bounded reconciliation route below, not a third normal review.
5. Stamp only with actual `COMPLETION: complete`, or explicit complete reconciliation, on the exact verified candidate. A two-pass stamp has no `--review` argument: its receipt records the real plan and combined completion, an empty reviews list and zero rounds. Quote the section's Test checkpoint and actual gate results. Run `validate` and `plan --sync`, commit the receipt and projection, confirm HEAD and status, announce the stamp and SHA, and continue the next ready section in scope.

## Normal review and stamp commands

Replace all angle-bracket arguments with verified values. The findings path must match the section. Write prompts to scratch. Every review reads a stable worktree with all writers paused. Use the normal long-running tool session and poll for completion; Claude's `run_in_background` flag is not a Codex argument.

```bash
python3 scripts/review-dispatch.py --check-pin --json
python3 scripts/review-dispatch.py --writer codex --kind plan --candidate <plan-sha> --prompt <plan-prompt> --record <findings-path>
python3 scripts/review-dispatch.py --writer codex --kind completion --candidate <final-sha> --prompt <combined-prompt> --record <findings-path>
python3 scripts/todo-graph.py stamp 'DNN TNN §N' --sha <final-sha> --plan <findings-path> --completion '<findings-path>:complete' --check '<quoted checkpoint and command> -> <observed result>'
```

Use `docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md` as the canonical findings path. The committed pin authorizes and schedules each pass; stamp replays that evidence. Do not hand-author approval records, switch writers, relabel historical passes or bypass a refusal.

### Transition an existing plan without inventing a round

A genuine legacy `codex-self-review` plan can enter the new combined route only when its findings contain no round or completion attempts. The new committed pin must additionally enable `plan_transition = ["codex-self-review"]`; add `--transition-plan` explicitly to the combined completion command. The dispatcher binds the original plan prefix, digest, candidate and pin under the new committed authorization; known-outage retries retain that binding. The original plan remains unchanged and the plan-before-build gate still applies. Chains with implementation-review attempts already present retain their legacy route unless separately authorized, including their actual original round at stamp. Never delete attempts to qualify for transition.

### Recover a normal combined completion result

The dispatcher persists pending-call identity in `build/review-completion/` before the combined call and its returned response before writing findings. A response not recorded in the findings cannot support a stamp. Recover the same persisted response without another reviewer call:

```bash
python3 scripts/review-dispatch.py --recover-completion --record <findings-path>
```

Preserve unresolved call markers and failed result-persistence state. Report the exact recovery blocker; do not delete state or infer that no review returned. Only a known non-returned outage may retry. `--list-rounds` and `--list-rounds --json` expose pending and recorded review state despite the historical command name.

## Bounded completion reconciliation

Operator-authorized D00 T01 §35 adds one exceptional pass for a valid Codex chain ending `COMPLETION: gaps`: a two-pass plan/combined completion chain or a preserved historical plan/round/completion chain. The committed pin must explicitly enable `reconciliation = ["codex"]` and its schedule. Preserve every original review byte, candidate and pin. This route does not migrate another writer's chain, repeat a regular review, rewrite a failed verdict or grant automatic acceptance to existing blocked sections.

Commit a disposition document under `docs/reviews/` that identifies the original section, plan and completion candidates, every original finding, its approved requirement, the repair and falsifiable evidence, or the evidence that it is genuinely outside the unchanged approved contract with an owner and explicit deferral. Include all intervening changes and affected regression gates. Never narrow the original contract or relabel safety breaches, real in-scope defects or regressions as optional. Use the unchanged candidate for a scope-only decision or an exact descendant containing the repairs. Prepare `docs/reconciliation-review-prompt.md`; keep the worktree quiescent throughout the call.

```bash
python3 scripts/review-dispatch.py --writer codex --kind reconciliation --candidate <verified-sha> --disposition docs/reviews/<disposition>.md --prompt <reconciliation-prompt> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
python3 scripts/todo-graph.py stamp 'DNN TNN §N' --sha <verified-sha> --plan <findings-path> --completion '<findings-path>:gaps' --reconciliation '<findings-path>:complete' --check '<quoted checkpoint and command> -> <observed result>'
```

The command above is for a two-pass chain and has no round. For a preserved legacy three-pass chain, additionally supply its actual `--review` argument and use `clean` when that round found nothing or `fixed` only when its repairs are verified. Only a returned `RECONCILIATION: complete` can support the stamp. The receipt keeps the original completion verdict `gaps` and adds reconciliation evidence tied to its digest, original findings, exact candidate, committed disposition and authorized pin. A returned `RECONCILIATION: gaps` exhausts this bounded pass and leaves the section blocked pending a new explicit coordinator decision; continue independent ready work. No extra normal review, second completion or automatic retry of a returned reconciliation is allowed.

A new explicit coordinator decision after a returned reconciliation gap may authorize one successor for that exact failed pass. This is exceptional, not another normal review: the committed pin's `reconciliation_extensions` maps the canonical report path to the exact failed predecessor digest. A version 2 binding retains every preceding findings byte and the predecessor identity, requires the same or a descendant candidate and unchanged approved obligations, and permits at most two returned reconciliations in total. Only the final authorized returned verdict `complete` permits stamping; missing or mismatched authorization, a successful predecessor, lost history, a third returned pass or remaining gaps refuses. Known non-returned outages retain the same binding and durable recovery rules. Removing authorization stops new successors but preserves historical validation. The initial scoped authorization is D00 T01 §36 only, recorded in AGENTS.md; it grants no blanket retry to other sections.

If writing the findings fails after a response returns, the response is unrecorded and cannot support a stamp. Preserve the durable pending-call/result state in `build/review-reconciliation/` and use `python3 scripts/review-dispatch.py --recover-reconciliation --record <findings-path>` to replay that same persisted result without a model call. If the call state is unresolved or the returned result could not be persisted, fail closed, preserve the marker and report the exact recovery blocker; do not delete the marker or infer that no review returned. A known outage with no returned review may be retried through the supported dispatcher. Inspect `--list-rounds` or `--list-rounds --json` for the original completion and pending, complete or blocked reconciliation state.

Rollback stops new reconciliation calls by removing its authorization from a newly committed pin; it preserves all historical pins, findings, disposition documents, pending state and receipts. Previously recorded evidence must remain verifiable. Removing evidence or relabeling an old completion is never rollback.

## Continue and wait

Work one section at a time. At boundaries check the inbox and CI, then pick the next ready section in the current wave. The coordinator follows the existing CI-gated merge procedure; a local green test is not CI or deployment proof. When dependencies block all work, publish the exact blocker and use a real session wake mechanism if available. If no verified Codex heartbeat exists, keep the run attended and report that it needs a queued resume or operator resume. Never claim a scheduled run or acquire a guard using a fabricated heartbeat. An existing guard is released or handed over only through `campaign_guard.py` with its documented ownership checks.

## Exact evidence-bound exceptions

D00 T01 §38 adds dormant version 3 capability only for the two report/kind pairs in `docs/todo-workflow.md`. It is not a larger review cap. Never create a live authorization from the existence of this capability: obtain the coordinator's separate exact case decision, preserve the original chain and every failed reconciliation, and commit the strict authorization document before its pin reference. Eval requires zero returned predecessors and its exact approved contract amendment; voice requires two ordered returned gaps and unchanged original contract. Every candidate descends from the original completion, all predecessors and repair base.

Use the existing `--kind reconciliation --writer codex` command and committed disposition. The dispatcher verifies authorization and preserves its identity through invocation, outage retry, durable response recovery and receipt replay. Only a genuinely returned `RECONCILIATION: complete` can stamp, retaining original completion gaps and separate version 3 binding evidence. An unresolved call blocks invocation, a known non-returned outage retains its exact binding, and a returned version 3 gaps verdict remains blocked with no successor. Removing authorization blocks new calls, not recovery of the same persisted response or historical receipt validation. Do not rewrite findings, alter the frozen product contract or fabricate review evidence.
