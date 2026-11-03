---
name: review-todo-section
description: Quality-gate a just-implemented TODO section with self-review, independent review lenses and a bounded fix loop, then write the Verified stamp through the stamp command. Also runs in audit stance on shipped sections. Use after process-todo-section or when asked whether a section is really done.
---

# Review TODO Section

The gate between "code exists" and "the row says `[x]`". Nothing else may flip that row, and the flip happens only through `python scripts/todo-graph.py stamp`, which refuses a section with unticked items, an open prerequisite, a waiting Need, or no review evidence.

Review is mandatory and independent: the implementing session self-reviews, and at least one review round comes from a reviewer of a different model, the one pinned in `.conclave/reviewers.toml` (the `reviewer` kit: one reviewer of a different model family from the writer, no fallback; the pin as installed routes `claude` to GPT-6 Astra through the Codex CLI, and the project owns its pin), run through `scripts/review-dispatch.py`. The pin's `[schedule]` owns each pass's reasoning effort and lenses, so the writer never picks them. As installed: the plan review (`process-todo-section` step 3a) and the completion review run at `medium`, round 1 at `medium` (adversarial, integration, source-defect, plan-delivery; nothing runs at `high` since 2026-10-31, operator), round 2 at `medium` (adversarial), round 3 at `low` (adversarial), and every later round at `low` with one lens in rotation (consistency, quality, design when `--surface` is passed, optimization, record). A `low` round that declares `HIGHEST: P1` makes the next round the `medium` adversarial escalation. Every round is recorded in a findings file; the stamp's receipt names the rounds. A verdict with no record is an opinion.

## Use this skill when

- A section was just implemented (`process-todo-section` ends by invoking this).
- The user asks "is §N really done?", "re-verify §N", "audit §N": run in audit stance (below).
- Before closing a TODO file with `process-todo-file`.

## Step 0: resolve the argument

Same front door as `process-todo-section`: `python scripts/todo-graph.py resolve "$ARGUMENTS"`. Exit 3 means the row is already `[x]`: that is the signal for audit stance, not an error.

## The three questions

Every review answers these with code and behavior evidence, never assertion:

1. **Does it make sense?** Does the implementation produce the exact outcome the section asked for, without unnecessary scope?
2. **Is it logical?** Do the contracts agree: threading rules, error paths, settings consumers, UI states, failure behavior?
3. **Did it break anything else?** Inspect callers, consumers, tests and adjacent workflows that read what changed.

## Workflow

### 1. Fix the candidate

Name the candidate: the implementation commit, or the commit range (`<BASE_SHA>..<TIP_SHA>`) when the section landed across multiple logical step commits or when fix-loop commits append (commits are never amended once review starts). Record the full SHA(s) in the findings file at `docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md`. For an audit, the candidate is the section's own stamped commit plus every later change to the files it owns, up to today's tip (`<STAMPED_SHA>..HEAD -- <owned paths>`): a regression lives in those later changes. Read the actual diff (`git show` or `git diff <BASE_SHA>..<TIP_SHA>`), not memory of writing it. Map each ticked micro-step checklist item (its `Done when:` and `Cheaper substitute:`) to the code and test that satisfy it; an item with no corresponding change or a partially met `Done when:` (`partial-flip-shipped`) is not done (untick it) or was already true (note where). On a stamped section (audit stance) edit nothing in the section by hand: record the item in the findings file, and when it is a regression, run `unstamp` first; the item is unticked in the reopened section afterwards.

### 2. Self-review

Work the three questions across the diff and its blast radius. Fix what you find, then re-ask them. Look specifically for the failure modes this codebase invites:

- The failure modes the project's `AGENTS.md`, governing plan and SPEC call out for the area you touched: list them in the findings file and check each one.
- An error path that throws, aborts or swallows instead of returning the project's typed error, or a failure reported as success.
- Work on the wrong thread, mutable state shared across threads, or unbounded recursion or allocation on hostile input.
- A file write that is not temp-then-replace, or an original modified in place.
- A hard-coded colour, size or string where design tokens or settings own it, or a control without an accessible name.
- A setting nothing reads, a command nothing reaches, or a link or automation that acts without asking.
- A test that passes without exercising the behavior.

### 3. Completion and excellence review (one pass)

Before the regular rounds, once per section, the pinned reviewer reviews the built feature as a user meets it and against the strongest competitor or alternative. Write the prompt to a scratch file from `docs/completion-review-prompt.md` (the candidate SHA, the section contract, the TODO file's Goal and Outcome, the SPEC sections and design source named in Fidelity, the delivered diff), then run it, naming your own agent as the writer (`claude`, `codex` or `gemini`):

```bash
python3 scripts/review-dispatch.py --kind completion --candidate <full candidate SHA> --writer <claude|codex|gemini> --prompt <scratch-completion-prompt.md> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
```

The dispatcher appends a `## Completion review` section (reviewer, model, candidate SHA), not a round: it is not counted against the cap, and a findings file takes one returned completion review. Part 1 lists every control, menu item, command, dialog, state, setting consumer, error and refusal path, undo or reverse path and persistence read-back the feature needs, each `present`, `missing-in-scope` or `missing-out-of-scope`. Part 2 names how the strongest competitor or alternative does the job and lists where the feature falls short of beating it (speed, steps, defaults, error recovery, accessibility, polish), each `in-scope` or `out-of-scope`. The review ends `COMPLETION: complete` or `COMPLETION: gaps`.

Then, before any regular round, implement every `missing-in-scope` gap and every `in-scope` excellence item in this section (new commits appended to the candidate, the section's checklist and gates covering them), and file every `missing-out-of-scope` gap and `out-of-scope` item through `add-todo` as a new section (an improvement that changes the designed surface is filed as a design-source change first). Under the completion review in the findings file, add one line per gap: `- Implemented: <gap> in <commit>`, or `- Filed: DNN TNN §N (<gap>)` for each section filed (the stamp reads these lines and refuses a ref that does not resolve), and add a `> **Deferred:** <what> -> XREF: DNN TNN §N` line to the section when its surface shows the filed item. The stamp takes `--completion '<findings file>:complete'` (no gaps), `:completed` (every gap implemented in the section) or `:filed` (some gaps filed as new sections, each on a `- Filed:` line). When the dispatcher exits 1 (the reviewer returned no completion review), run the pass again; the regular rounds wait for it.

### 4. Independent review rounds (the pinned reviewer)

The dispatcher picks each round's lenses and effort from the pin's schedule (the lens table below is the vocabulary), at least one round by the pinned independent reviewer. Write the prompt to a scratch file from `docs/review-round-prompt.md` (candidate SHA, section contract, governing documents, lenses), then run it, naming your own agent as the writer:

```bash
python3 scripts/review-dispatch.py --writer <claude|codex|gemini> --prompt <scratch-review-prompt.md> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
```

The dispatcher appends a `## Round N` section naming the reviewer, its model, effort and lenses, or `none` with the reason when the reviewer returned no review. A round with no review counts for nothing: fix the cause (a CLI not signed in, a sandbox that cannot read the repository, so the diff goes in the prompt) and run the round again. Pass `--surface` on every round of a `Surface: yes` section so the rotation includes the `design` lens. A section's `**Risk:**` needs no flag: the dispatcher reads it from the section the findings file names and runs a `light` section's rounds on `[schedule.light]` (D00 T01 §15). Headings that start `## Round`, `## Completion review` or `## Plan review` are reserved for what `--record` writes: a writer's own note in a findings file uses another heading (for example `## Writer note: ...`), or the file stops being readable and the next review is refused with the offending line named. Complete that round with the candidate SHA, per-lens verdicts (`approve`, `needs-attention` with numbered findings naming `file:line`, or `advisory`), and the quoted gate outputs (the Live proof). On Windows run `python` instead of `python3`. A repository without `scripts/review-dispatch.py` gets it with `forge.py kit . reviewer`.

| Lens | Asks |
| ---- | ---- |
| `plan` | Will the section as written produce a 100% complete feature? (plan review only) |
| `plan-delivery` | Does the build deliver every planned item, with nothing quietly narrowed? |
| `adversarial` | How does this fail on hostile input, races, aborts, automation or links? |
| `consistency` | Does it match the module rules, naming, shared components and settings? |
| `integration` | Do callers and consumers still hold, with every contract kept? |
| `source-defect` | Is the upstream spec or SPEC read accurately with deviations noted? |
| `quality` | Is the code clear, tested where it can fail, and free of dead or duplicated logic? |
| `design` | Does the rendered UI match the design source and its tokens? |
| `optimization` | Is there avoidable work, allocation, latency or step count on a hot path? |
| `record` | Does evidence match what ran, with owned deferrals and earned flip? |

The loop is bounded: at most 3 regular rounds (5 reviews total including the plan review and completion review, all at `low` effort; operator, 2026-11-03 20:02 SAST; a round that returns no review does not count), and it ends early on severity. The round prompt in `docs/review-round-prompt.md` asks for a `P1`/`P2`/`P3` tag on every finding (an untagged one counts as `P1`) and for a `HIGHEST:` line before `OVERALL`. Severity is proportional: only a failure that can happen in real operation with real input is `P1` or `P2`; a contrived scenario is `P3`. The first round with no `P1` or `P2` finding (the pin's `severity_stop_after` sets the earliest round it may come from; `stamp` accepts the stop only when that round's line reads `HIGHEST: P3`) stops the loop, its findings are filed through `add-todo`, and the section stamps with `stopped-low-severity` and a `--cap-outcome` naming what was filed. The cap is room, not a quota. Findings are fixed in new commits appended to the candidate, gates re-run, and the affected lenses re-run against the new tip. A unit patched three rounds running is stopped and re-thought instead of patched again. When the rounds keep finding spellings that slip past a home-made parser or scanner of something a tool owns (includes, link inputs, symbols, encodings, file formats), move the proof to that tool's own output (the compiler's or linker's dependency reports, the platform's binary inspection tool, an OS API) and keep the scanner only as an early warning; that is the owning-layer fix, and spelling bypasses of the early warning stop being `P1` unless they also defeat the tool-reported proof. Round verdicts for the receipt: `clean` (no findings), `fixed` (findings found and fixed in a later round), `stopped-at-3` (cap reached; `stopped-at-33`, `stopped-at-22`, `stopped-at-13` and `stopped-at-8` remain valid on receipts written under earlier caps, but a new stamp refuses them; every leftover is filed through `add-todo` with an owner, or the run stops with no stamp when a leftover is safety, data-integrity or stamp-invalidating). At the cap nobody is asked, attended or not: a stamped section carries the outcome in its receipt (`--cap-outcome`), and an unstamped one records it in its findings file under `## Cap reached` (rounds spent, every leftover, where each was filed) and in the run file, and the phase carries on with its other ready rows. When the dispatcher exits 1 (the reviewer returned no review), record the outage in the findings file with an owner and a due date and stop without a stamp: a session-only pass is not a substitute.

Architecture check: on sections touching an architectural boundary the governing plan names (process or thread contracts, data ownership, module seams), one findings-file paragraph answers whether the change keeps the governing plan's architecture intact, naming any decision it effectively revises. A revision is recorded as a plan correction, never smuggled in as code.

### 4a. The final review (once, after the rounds stop)

When the pin has a `[schedule.final]` step whose `mode` is not `off`, the section gets exactly one final review by that reviewer (Muse Wonder Full here) once the rounds have stopped (with `mode = "optional"`, a reviewer that returns no review is a warning and the stamp may go without `--final`; with `mode = "off"` skip this step and stamp without `--final`), in the foreground, on the candidate tip:

```bash
python3 scripts/review-dispatch.py --kind final --candidate <full candidate tip SHA> --writer claude --prompt <scratch-review-prompt.md> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md
```

The dispatcher refuses it until the last returned round declares no P1 or P2, and refuses a second one. It is recorded as `## Final review`. If it declares a P1 or P2, fix each finding in this section with its regression test, then run one more regular round (step 4) on the fix: that round, not another final review, proves it. The stamp then takes `--final '<findings file>:fixed'`; with no P1 or P2, `--final '<findings file>:clean'`.

### 5. Re-run the gates

After the last fix, re-run the section's Test checkpoint and its owed gates (affected test suites, build warnings clean, `validate`, the Freeze check in frozen files, any sanitizer build the section names). Quote the outputs in the findings file. A fix verified by reasoning is not verified. A red gate reopens the candidate: fix, re-run to green, and re-run the affected lens, because earlier verdicts rested on the broken candidate.

### 6. Surface, feature, and frozen checks

Fidelity follows the contract at the top of `design/SPEC.md`: compare the built page with its board's PNG for the must-match list only; data, counts, plan-set numbers and measurements within the token scale are not findings, and a recorded `Deviation` with a reason that holds is accepted. Surface and feature completeness: 100% of every control, menu item, dialog and state on the Fidelity counterpart is working (proven on the rendered surface with real data and read-back in this review) or deferred to a named, resolving section, and every required refusal/error/undo path is exercised. Refuse the stamp for an unaccounted control or a `Cheaper substitute` shortcut. Frozen files: every `**Freeze check:**` ran and passed with the result quoted; a frozen behavior that moved without a recorded operator approval means no stamp and a question for the operator.

### 7. Stamp

Tick nothing by hand. Confirm every checklist item except `Commit:` is `[x]`, then:

```powershell
python scripts/todo-graph.py stamp 'DNN TNN §N' --sha <full candidate tip SHA> --plan 'docs/reviews/<domain>/D<NN>-T<NN>-s<N>.md' --completion 'docs/reviews/<domain>/D<NN>-T<NN>-s<N>.md:complete' --final 'docs/reviews/<domain>/D<NN>-T<NN>-s<N>.md:clean' --review '1:docs/reviews/<domain>/D<NN>-T<NN>-s<N>.md:clean' --check '<checkpoint command> -> <quoted result>'
```

One `--plan` (required, naming the section's own findings file; `stamp` refuses without it, with any other file, with a findings file that holds no `## Plan review` returned by another model family and ending `PLAN: complete` or `PLAN: gaps` then its `OVERALL:` line, or with a plan review whose candidate is not the commit that recorded the section's `Started:` line or an earlier one, or a later commit only when the section has an explicit `Started:` line and, every commit that descends from the Started commit and leads to the candidate (a branch forked after it included) changes only `todo/` and `docs/reviews/`, or reformats an existing JSON file under `test/` or `tests/` to the same parsed value, and leaves the section's contract (its text and its TODO file's preamble, its own Implementation Order row found by its `§N` column) byte for byte as it was; the receipt records that evidence as `plan.after_started` and validation rebuilds it, and refuses it missing when the candidate follows the Started commit (D00 T01 §28)), one `--completion` (required; `stamp` refuses without it, with an unknown verdict, with a findings file that holds no returned `## Completion review`, with a verdict the review's `COMPLETION:` line does not support, or with a `filed` verdict whose `- Filed:` refs are missing or do not resolve), one `--review` per round, one `--check` per gate actually run. `stamp` also replays the pin's `[schedule]` (at the stamped commit) through the dispatcher's own scheduler and refuses any pass, the plan review, the completion review or a recorded round (outages included), whose effort or lenses differ from what the schedule gave it, naming the pass, the expected and the recorded values. With a `stopped-at-33` or `stopped-low-severity` verdict add `--cap-outcome '<what was done when the cap was reached>'` (which leftovers were filed where, or why the section stays unstamped); `stamp` refuses a stopped verdict without it. The receipt records the plan review (`plan`: findings file, candidate, reviewer, model, effort, lenses, and `after_started` with the Started commit and the commits from it to a later candidate), the pin's schedule (`schedule`), the completion review (`completion`: findings file, verdict, candidate, reviewer, model, filed sections), `rounds_spent` (every round the dispatcher recorded in the findings file, outage rounds included), `round_cap` and `cap_outcome`; `python scripts/todo-graph.py query rounds` lists them across stamped sections so the cap can be tuned. `stamp` writes the receipt `docs/reviews/<ref>.json`, ticks the `Commit:` item and the Implementation Order row, appends the `Verified:` and `Review:` lines, marks the file `done` when its last section stamps, and the CLI syncs the plan. Commit the stamp, receipt, findings file and regenerated plan together as `todo: stamp <ref>`. Add any `Deferred:` lines (each with its `-> XREF:` owner) and `Started:` to `Duration:` notes to the section before stamping, since a stamped section's checklist is never rewritten; a later change is a new section that names the old one.

### 8. Audit stance

On an already-`[x]` section: run steps 1, 2 and 4 to 6 against the section's own candidate and receipt (an audit may add a completion review, step 3, in its own audit findings file; a receipt stamped before completion reviews existed has none and stays valid without one), changing nothing in the section itself until `unstamp` has reopened it. Record the audit's rounds in a findings file of their own, `docs/reviews/<NN-domain>/audit-d<NN>-t<NN>-s<N>.md` (`--record` that path), never in the section's stamped findings file: its receipt names that file's last round, so a round appended there makes the receipt refuse validation and blocks `unstamp`. Confirm the stamp's evidence still holds (re-run the checkpoint) or find the regression. The only permitted row change is `[x]` back to `[ ]`, and only through `python scripts/todo-graph.py unstamp '<ref>' --reason '<what regressed; repair -> XREF: <ref>>'`, which removes the stamp lines, unticks the `Commit:` item and the row, reopens the file, keeps the receipt as `docs/reviews/<ref>.revoked-<date>.json` and adds a dated `Unstamped:` note (a hand edit leaves the graph refusing a checkbox/stamp mismatch). File the repair with `add-todo` first so the reason can name it, and say plainly that downstream sections stamped on this one are suspect until it re-stamps: they keep their stamps (the graph accepts a stamped section whose prerequisite carries an `Unstamped:` note) and `unstamp` prints them. A re-confirmed row keeps its stamp; say so in one line.

## Guardrails

- Do not stamp without a findings file, its one plan review, its one completion review, and at least one independent round.
- Do not stamp an unaccounted control on a surface section, or a moved frozen behavior.
- Do not hand-write `Verified:` lines, hand-flip rows, or edit a receipt. `stamp` owns the record.
- Do not review the working tree when the candidate is a commit or range. Name the hashes.
- Do not transfer evidence across changed candidates: a new tip re-runs its gates.
