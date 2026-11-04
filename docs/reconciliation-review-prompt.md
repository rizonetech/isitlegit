# Bounded completion reconciliation prompt

Copy this into scratch, fill every placeholder with verified values, and run `python3 scripts/review-dispatch.py --writer codex --kind reconciliation --candidate <FULL_SHA> --disposition docs/reviews/<disposition>.md --prompt <file> --record docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md`. The disposition must already be committed. The committed pin must authorize reconciliation. Run only on a stable worktree after a valid Codex chain ending `COMPLETION: gaps`: either a two-pass sound-plan/combined completion chain or a preserved historical plan/round/completion chain. Do not invent a round for a two-pass chain. This is the sole exceptional reconciliation, not another ordinary round or a replacement completion.

---

You are the Codex completion reconciliation self-reviewer. Do not edit any file. Verify every original completion finding against the unchanged approved obligations and the exact candidate below. The original review remains failed and immutable; your actual findings are recorded separately. Do not infer approval from the author's disposition, tests alone, an earlier pass or deadline pressure.

## Candidate and original evidence

- TODO section and contract path: `<DNN TNN §N>`, `<todo-path>`.
- Original plan candidate and findings path: `<PLAN_SHA>`, `<canonical-findings-path>`.
- Original completion candidate and digest: `<ORIGINAL_COMPLETION_SHA>`, `<original-completion-digest>`.
- Exact candidate to verify: `<FULL_SHA>`, identical to the original completion candidate or its descendant.
- Committed disposition document and commit: `docs/reviews/<disposition>.md`, `<DISPOSITION_COMMIT>`.
- Governing design, fidelity and frozen obligations: `<paths and sections>`.
- Actual repair and regression gates: `<commands, candidate and observed results>`.

The dispatcher records the binding to the original findings bytes, original completion, candidate, unchanged contract, committed disposition and authorized pin. Inspect that evidence and the actual committed sources. Do not accept missing, stale or mismatched evidence or a narrowed contract. Read the original plan and its dispositions, any genuine historical implementation round, the failed completion and the full diff from the original completion candidate to the verification candidate. A scope-only reconciliation still verifies all original obligations at the same candidate.

## Required verification

1. Enumerate every original completion finding without omission. For each, identify the original approved obligation or the evidence that it is genuinely additional scope. Treat the original plan and governing documents as obligations, not just the latest checklist.
2. For each actual defect, unmet requirement or regression, inspect the repair, callers and failure paths. Name the exact source and falsifiable tests or runtime evidence that prove it fixed. A passing unrelated test or an author's assertion is insufficient.
3. For a genuinely out-of-scope addition, verify the classification against the unchanged approved contract, record the named owner and explicit disposition, and state that the addition is not implemented by this section. Safety breaches, real in-scope defects and regressions cannot be relabeled optional. Do not accept narrowing the approved contract or weakening an already-decided improvement.
4. Inspect every intervening change for new regressions and verify the exact candidate still meets all Done when clauses, Test checkpoint, governing design and frozen safety requirements. For a two-pass chain, retain the combined review's quality, consistency, adversarial, integration, source-defect, plan-delivery, record, optimization and applicable design obligations; verify every agreed requirement is completed and correctly implemented. Report any newly introduced blocking defect as a gap.
5. Preserve the original findings, candidate identities, pins and failed completion. Do not propose editing their verdicts, dropping evidence, running another ordinary round or repeating reconciliation until it approves.

## Reply format

Give a numbered disposition for every original finding, with its requirement, classification and exact supporting evidence. Then list any remaining or new blocking findings separately from additional suggestions. Explain the owner and disposition of each additional suggestion. End with exactly one terminal line:

- `RECONCILIATION: complete` only when every original finding is verified as resolved or genuinely additional scope, all approved obligations are met, and no blocking regression remains on the exact candidate.
- `RECONCILIATION: gaps` when any blocking issue or unproven obligation remains. This exhausts the one returned reconciliation and does not permit a stamp.
- `RECONCILIATION: blocked` when the required candidate or evidence could not be read, with the reason immediately above. This is not approval.

A returned complete result supports only the exact candidate it examined. Saving the result and stamping are the dispatcher's and graph's responsibility, never a reviewer-authored receipt.
