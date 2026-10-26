## Round 1: astra (`gpt-6-astra` via `codex`)

- Writer: claude
- Run: 2026-10-26T21:38:05Z
- Effort: high
- Lenses: adversarial, integration, source-defect, plan-delivery
- Lines: 20
- Digest: 813674a09778a078

**adversarial: needs-attention**

1. **P1: Missing severity declarations pass as clean.** [scripts/lib/todo_graph.py:357](../../../scripts/lib/todo_graph.py#L357) treats `highest() == None` as no serious findings. Reproduce with a final response containing `P1 example.ts:1 unsafe execution.` followed by `OVERALL: needs-attention`, but no `HIGHEST:` line. `--final ...:clean` accepts it without a corrective round. The same response from Astra also unlocks final dispatch at [scripts/review-dispatch.py:898](../../../scripts/review-dispatch.py#L898). Both paths reproduced in memory. Require an explicit valid severity declaration.

**integration: needs-attention**

2. **P1: Another section’s final review satisfies the stamp.** [scripts/lib/todo_graph.py:346](../../../scripts/lib/todo_graph.py#L346) validates the report’s location but never binds it to the section. Reproduce by stamping section 2 with `--final docs/reviews/00-workspace/D00-T01-s1.md:clean`, where section 1 has a clean final under the same schedule and its candidate is an ancestor. Its final review is accepted even though section 2 received none. The in-memory probe confirmed this acceptance. Enforce the section’s own findings path, as `plan_record()` already does.

3. **P2: A malformed final response permanently blocks recording a valid retry.** The final pass uses [scripts/review-dispatch.py:920](../../../scripts/review-dispatch.py#L920), whose recorder refuses another pass whenever any earlier entry has a reviewer, regardless of whether it returned a valid verdict. Reproduce with Muse returning nonempty text such as `Unable to complete this review.` without `OVERALL:`. The first dispatch exits 0, stamping refuses because zero valid finals exist, and a valid retry exits 2 without recording its response. Validate returned final responses before consuming the one-pass allowance.

**source-defect: approve**

No additional findings.

**plan-delivery: needs-attention**

4. **P2: Retrying a completed final runs Muse again.** [scripts/review-dispatch.py:902](../../../scripts/review-dispatch.py#L902) invokes the reviewer before checking whether a final already exists. Reproduce by running the same successful `--kind final` command twice. The second invocation performs another review, then refuses its recording. The in-memory probe confirmed one reviewer invocation on the rejected retry. Check for an existing final before dispatch to enforce the promised once-only execution.

HIGHEST: P1
OVERALL: needs-attention
