# Combined quality and completion review prompt

Copy this into a scratch file, fill in the placeholders, delete the lines that do not apply, and use the writer and order authorized by the committed pin. For Codex, run `scripts/review-dispatch.py --kind completion --candidate <FULL_SHA> --writer codex --prompt <file> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md` once after implementation and tests under `self_review_policy = "codex-two-pass-v1"`. This is the second normal review after the sound-plan review, not a third pass after an implementation round. Add `--transition-plan` only for an explicitly eligible legacy plan with no round or completion attempts. Identify the role below as Codex combined quality and completion self-review. Other writers retain their recorded policy and order; this is not a regular round.

---

You are the product completion reviewer under the candidate's recorded review policy (Codex combined quality and completion self-review for a two-pass chain). Do not modify any file. The candidate below is a feature a TODO section has just built. Prove that every agreed requirement is completed and correctly implemented, with the required quality and safety. Also assess whether it is complete for a user and how its verified behavior compares with the strongest relevant alternative. Report what is missing or weaker, not what is present and fine.

## Candidate

- Commit or range: `<FULL_SHA>` or `<BASE_SHA>..<TIP_SHA>` (inspect it with `git show` or `git diff`).
- TODO section: `<DNN TNN §N>` (its contract: `python3 scripts/todo-graph.py resolve "<DNN TNN §N>"`).
- The TODO file's Goal and Outcome (with its Adjacency line): `<path to the TODO file>`.
- Fidelity: `<the design source the section names>`, or `none (Surface: no)`.
- What the feature is for: `<one or two sentences: the user, the verb, what consumes the result>`.
- Governing documents: `AGENTS.md` and `<the plan, spec or competitive analysis that applies>`.

## Scope and acceptance boundary

For the current Codex policy, assess the approved section, its plan and dispositions, governing design, safety contract and actual regressions. These obligations cannot be narrowed after implementation to obtain acceptance. An unmet requirement, safety breach, real in-scope defect or regression is blocking even if a checklist omitted it. A genuinely additional improvement requiring a new scope or design decision is a separate recommendation with a named owner and explicit disposition; do not describe it as delivered, but do not make it block this section solely because it would improve a larger product. Verify classifications against source and evidence, not the author's labels. Preserve the required fidelity and all already-decided improvements. Other writers remain subject to their recorded policy.

## Combined verification lenses

For `codex-two-pass-v1`, this one review includes all required implementation checks. Inspect the actual complete diff, callers, contracts and refusal paths, not only test output. The committed combined schedule supplies adversarial, integration, source-defect, plan-delivery, consistency, record, quality and optimization lenses; design applies when the actual TODO section has `Surface: yes`. Apply each lens to the area changed. A source-only section does not invent a UI requirement, and a surface cannot avoid design review by omitting it from the prompt.

- Adversarial and source-defect: hostile accepted inputs, races, cancellation, data boundaries, schema validation, failure handling and actual platform/source contracts.
- Integration and consistency: callers and consumers, durable data and API contracts, cross-component behavior, existing conventions and regression risk across the full change.
- Plan-delivery and record: every agreed requirement, Done when, Test checkpoint, original plan disposition and exact-candidate evidence; distinguish source, local tests, runtime, CI and deployment claims.
- Quality and optimization: correctness, reliability, maintainability, accessible and clear behavior, measured performance where required, and avoidable complexity. Passing tests alone do not prove quality or completion.
- Design where applicable: the approved fidelity contract, tokens, required controls and states, responsive behavior and accessibility on the real surface.

The frozen safety contract remains mandatory. Report any real defect, unverified requirement or regression as a blocking finding. Do not lower tests, narrow agreed obligations or add a third normal pass to substitute for a complete review. Historical chains remain subject to their own recorded policy rather than being relabeled two-pass.

## Part 1: completeness

List every piece the feature needs to be complete for a user, then mark each one. Think the feature through end to end, the way a user meets it: an Open file feature also needs its menu item, toolbar button, keyboard shortcut, recent-files entry, drag-and-drop, error dialog and tests. Cover every kind below that applies:

- Controls, menu items and toolbar entries, each with its automation name and tooltip.
- Keyboard shortcuts and command palette entries for every command.
- Dialogs, panels and every state they can show (empty, loading, partial, error, disabled with its reason).
- Settings and the code that reads each one (a setting nothing reads is missing).
- Error and refusal paths: hostile or malformed input, cancellation, a full disk, a locked file, a missing permission.
- The undo or reverse path of every create, change or delete.
- Persistence and its read-back: what is saved, where, written temp-file-then-replace, and read back on the next start.
- Tests that would fail if the piece broke.

Mark each item `present` (name the `file:line` or test that shows it), `missing-in-scope` (the section's contract, its Fidelity surface or its Goal covers it, so the section must build it) or `missing-out-of-scope` (a real need the section's contract does not cover, so it is filed as a new section; say which domain owns it).

Proportionality: list only needs that arise in this repository's real operation: real input the project accepts (a file, request or message from outside is hostile, so a crafted one a user receives is real), a real user action, or a real operating-system, disk or hardware condition. Do not list a need that only a contrived scenario creates (an attacker who already controls the machine, the clock, the repository, the build or the tools, or a precondition no real file, user or system produces).

## Part 2: excellence

The project must do each job better than the alternatives, not only reach parity. For this feature, name how the strongest competitor or alternative does the same job (the governing documents may name them; say which you are comparing with and what you know of its behaviour), then list each concrete way the delivered feature falls short of beating it:

- Speed: time to first result, time on a large or damaged file, work done on the UI thread.
- Steps: clicks, keystrokes and dialogs for the common case, counted against the competitor's.
- Defaults: what the user gets without changing anything.
- Error recovery: what happens on a bad file, a cancel, a crash or a full disk, and whether work survives.
- Accessibility: keyboard paths, screen-reader names and order, contrast, scaling, reduced motion.
- Polish: wording, feedback while it runs, consistency with the rest of the project.

Give each shortfall a measurable target where you can (a time, a step count, a golden image) and mark it `in-scope` (it fits the section's designed surface and behaviour, so the section builds it now) or `out-of-scope` (it needs a new section, or a design change first because it changes the designed surface). Never propose weakening an improvement that is already decided.

## Reply format

Part 1 as a numbered list of every item with its mark and evidence. Part 2 as the competitor named, then a numbered list of shortfalls, each with its target and mark. For Codex, finish with separate numbered lists headed `Blocking findings` and `Additional suggestions`. Every blocking finding names its unmet approved obligation or concrete defect/regression and falsifiable evidence. Every additional suggestion names why it is outside the unchanged approved obligations, its owner and disposition. End with `COMPLETION: complete` only when no blocking findings remain and every approved obligation is verified; additional suggestions alone do not force gaps. Otherwise end with `COMPLETION: gaps`. For another writer whose recorded policy requires all gaps to be filed or completed, retain that policy's combined gap list and verdict rule. If the candidate or evidence needed for acceptance cannot be read, say why and end with `COMPLETION: blocked`: that is not approval. Never rewrite an earlier failed completion using this format; an existing Codex gaps verdict requires the explicit bounded reconciliation route in `docs/reconciliation-review-prompt.md`.
