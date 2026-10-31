## Round 1: astra (`gpt-6-astra` via `codex`)

- Writer: claude
- Run: 2026-10-31T14:52:47Z
- Effort: medium
- Lenses: adversarial, integration, source-defect, plan-delivery
- Pin: dab736d28178fc93db784edd8a4e594703c95c4b
- Lines: 16
- Digest: 325653a7911632c3

1. **P2, integration/source-defect:** [todo_graph.py:736](../../../scripts/lib/todo_graph.py#L736) searches current `HEAD` and `MERGE_HEAD`, without identifying the branch on which the pass ran. A lane can review under the old pin after main changes its schedule, then merge main. Revalidation now selects main’s newer pin, although that pin was absent from the lane during review. Path-limited history simplification can also hide a lane’s discarded pin changes. This can reject legitimate reviews or accept the wrong effort. `--full-history` alone cannot resolve branch provenance; ambiguous legacy passes need explicit pin evidence.

2. **P2, adversarial:** [todo_graph.py:736](../../../scripts/lib/todo_graph.py#L736) passes an unvalidated `Run` value to Git’s permissive date parser. Measured on this candidate: the findings parser accepts `Run: garbage`, and `pass_schedule()` resolves it to the current **medium** plan schedule; a valid October 29 timestamp resolves to **high**. Relative dates also make validation time-dependent. Reject malformed, relative and timezone-free timestamps before lookup. The two new tests cover only valid UTC timestamps.

3. **P2, integration:** [todo_graph.py:742](../../../scripts/lib/todo_graph.py#L742) treats a missing pin at the selected commit as “no pin was committed yet.” If the pin was deleted before the review and restored afterward, `rev-parse` fails, `pin_at()` returns `None`, and line 759 silently applies the stamped schedule. That can accept a pass without evidence of an applicable pin. Distinguish an empty history from a missing blob or lookup failure, and refuse the latter.

Lens verdicts:

- **adversarial:** needs-attention.
- **integration:** needs-attention.
- **source-defect:** needs-attention, historical lookup does not reliably preserve the pin actually used.
- **plan-delivery:** needs-attention, regression coverage omits these failure paths.

Read-only probes confirmed equivalent `Z` and `+02:00` timestamps select the same pin. The query uses committer dates; that does not establish branch provenance or eliminate clock skew. No repository changes; fixture tests were not run in the read-only sandbox.

**OVERALL: needs-attention**

## Round 2: astra (`gpt-6-astra` via `codex`)

- Writer: claude
- Run: 2026-10-31T14:58:05Z
- Effort: medium
- Lenses: adversarial, integration, source-defect, plan-delivery
- Pin: dab736d28178fc93db784edd8a4e594703c95c4b
- Lines: 14
- Digest: 4319d537969312a1

1. **P2, integration:** [scripts/lib/todo_graph.py:769](../../../scripts/lib/todo_graph.py#L769) drops a valid lane pin when the lane has not committed before its review. Sequence: lane branches at A; main changes the pin at B; lane reviews while still at A; lane commits C afterward and later merges main. At the review time, `inside` contains A and B, so the frontier removes A and returns only B’s pin. The legitimate lane review is rejected against main’s schedule. The new lane test misses this because it commits lane work before the review.

2. **P2, adversarial:** [scripts/lib/todo_graph.py:768](../../../scripts/lib/todo_graph.py#L768) can resurrect an obsolete weaker pin under committer-clock skew. In linear history A → B → C, let B’s timestamp fall after Run while A and C fall before it. The frontier returns both A and C because it removes only immediate parents inside the time boundary. A pass at C can consequently match A’s weaker schedule even though C superseded it. An in-memory probe returned both pins; ancestor exclusion must account for intervening commits outside the time boundary.

Lens verdicts:

- **adversarial:** needs-attention, obsolete schedules remain eligible under clock skew.
- **integration:** needs-attention, a lane without a pre-review commit loses its applicable pin.
- **source-defect:** needs-attention, these cases violate preservation of the schedule used by the pass.
- **plan-delivery:** needs-attention, regression coverage omits both histories.

Read-only in-memory probes confirmed both frontier results using the candidate’s `pins_at()`. Fixture tests were not run; no files changed.

**OVERALL: needs-attention**
