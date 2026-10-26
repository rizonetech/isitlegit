---
name: independent-review
description: Get an independent review of your own work from the reviewer pinned in .conclave/reviewers.toml (a different model family from yours) through scripts/review-dispatch.py, then verify and act on every finding. Use before calling a nontrivial change done, before a commit that ships, or when a TODO section needs its review round.
---

# Independent review

Your own review is not enough for a nontrivial change: a different model reviews it. `.conclave/reviewers.toml` names who reviews whose work, and `scripts/review-dispatch.py` runs the round.

| Work written by | Reviewer (as installed) | Fallback |
| --- | --- | --- |
| Claude (`claude`) | GPT-6 Astra (`codex`, scheduled effort) | none |

The pin as installed routes `claude` to GPT-6 Astra through the Codex CLI in a read-only sandbox; the project owns its pin and may change it in `.conclave/reviewers.toml`. A route names exactly one reviewer, never of the writer's own model family, and the pin refuses an unrouted writer, an unknown CLI, a second reviewer or a same-family reviewer. The pin's `[schedule]` sets each pass's reasoning effort and lenses, so the writer never picks them: the plan review before the build, the completion review after it, the first rounds at falling effort, then one lens per round in rotation.

Proportionality: only a failure that can happen in real operation with real input is `P1` or `P2`; a contrived scenario (a hand-edited record, a tool used against its contract, an input no real user or tool produces) is `P3` at most.

## Steps

1. Review your own change first and fix what you find.
2. Write the review prompt to a scratch file, not the repository, from `docs/review-round-prompt.md`: name the candidate commit or range, the governing documents, and the lenses that apply.
3. Run the round naming the agent that wrote the change as the writer, never another: a writer the pin does not route refuses, which is no review. Pass `--surface` when the change ships a user-facing surface (`Surface: yes`), so the rotation includes the `design` lens:

   ```bash
   python3 scripts/review-dispatch.py --writer claude --prompt <scratch>/review-prompt.md --record docs/reviews/<topic>.md
   ```

   On Windows use `python` instead of `python3`; the command is otherwise the same.
4. For planned work, two one-pass reviews bracket the rounds and are not counted as rounds: `--kind plan` (prompt from `docs/plan-review-prompt.md`) before the build, judging whether the plan produces a complete feature, and `--kind completion` (prompt from `docs/completion-review-prompt.md`) after it, judging the built feature as a user meets it. Both take `--candidate <40-character commit SHA>`.
5. Read the review. Every finding carries `P1`, `P2` or `P3` (an untagged one counts as `P1`), and the review ends with a `HIGHEST:` line before `OVERALL`. Verify every finding against the code before acting: fix what is real, and record why anything else is not.
6. Commit fixes as new commits and run another round on the new tip, up to 33 rounds (a round that returns no review does not count). The first round with no `P1` or `P2` finding (`HIGHEST: P3` or none) ends the loop, from the round after the pin's `severity_stop_after` (the installed pin sets 0, so from round 1); file its `P3` findings as follow-up work. A unit that needs patching three rounds running gets re-thought, not patched again.

## Rules

- The dispatcher's JSON output and the `## Round N` section it appends are the evidence. A verdict with no record is an opinion.
- Exit 1 means no review: the reviewer was not installed, failed, timed out, returned nothing or replied `OVERALL: blocked`, and no other reviewer runs in its place. That is never an approval: record the outage, say so, and do not ship on it.
- A reviewer that could not reach the work (its sandbox could not read the repository) replies `OVERALL: blocked`. Put the diff in the prompt and run the round again.
- Reviewers run read-only. Never pass a reviewer a secret, and never ask it to edit files.
- Change reviewers only in `.conclave/reviewers.toml`, never by calling a model directly.
