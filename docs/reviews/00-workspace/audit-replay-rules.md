## Round 1: astra (`gpt-6-astra` via `codex`)

- Writer: claude
- Run: 2026-10-31T17:38:28Z
- Effort: medium
- Lenses: adversarial, integration, source-defect, plan-delivery
- Pin: c1da548d4c402ac57b43a47bf85435e7c4086bc5
- Lines: 20
- Digest: 8a7fff2163a4ff66

- **P2, adversarial/integration: the unrestricted legacy fallback permits bypassing P1 escalation.** At [scripts/lib/todo_graph.py:917](../../../scripts/lib/todo_graph.py#L917), every round may use either rule, without evidence that the legacy dispatcher scheduled it. Reproduced against `a3d422cd`:
  1. Round 1: medium, four lenses, P2.
  2. Round 2: medium, adversarial, P2.
  3. Round 3: low, adversarial, P1, followed by a valid second-reading block.
  4. Round 4: low, adversarial, clean.

  Today’s rule requires **medium escalation** for round 4. The legacy rule ignores round 3 and schedules **low adversarial** again. The new check accepts it, including for newly recorded histories. A clean fourth round satisfies the closing-verdict and final-review eligibility checks, so those checks do not repair the bypass. Historical compatibility needs evidence identifying eligible legacy passes rather than an unrestricted alternative for every round.

Lens verdicts:

- **adversarial:** needs-attention, P2 above.
- **integration:** needs-attention, same P2. Scheduling can ignore a review that receipt accounting counts.
- **source-defect:** approve. The legacy predicate reproduces the previous closing-line rule.
- **plan-delivery:** needs-attention. The compatibility examples are covered, but the tests do not establish the requested safety property around escalation or mixed-rule histories.

The predicates differ only for valid closing reading blocks, but that changes both position and the last review used for escalation. Risk changes reset both calculations consistently. Final-review and stopped-at verdict checks continue using the current rule consistently; the inconsistency is with the newly broadened scheduling acceptance.

Verification: all four `SecondReadings` tests passed. Inspected both new stamp tests; their filesystem-writing fixtures were not run in this read-only session. Neither covers the counterexample above.

OVERALL: needs-attention
