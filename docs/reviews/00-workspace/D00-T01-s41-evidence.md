# D00 T01 §41 implementation evidence

Recorded 2026-11-04 by access session `01a1a622-9e2a-74b0-b381-c3a3c133993c` under coordinator LANES-34. This is author test evidence, not a review receipt or runtime acceptance.

Plan candidate `89bc68cc798f1cc00045017556a2eeb88a33247c` received a genuine LOW Codex plan self-review: `PLAN: complete`, no findings. The original dispatcher record is preserved in `D00-T01-s41.md`. The earlier call on `6b42cd90d3863b471610172fb3f533f3b322a022` refused before invocation because the section lacked Started metadata; the plan-preparation marker was committed before the genuine review or implementation.

## Change and guards

Only the stopped branch of `Registry.event` chooses different reason text. It uses the already locked, revalidated phase after the unchanged `paused()` guard. Completed work and stalled ownership get distinct descriptions; paused state and a matching pause marker keep the prior pause description. No raw error content is interpolated. Deny/continue=false response shapes and ownership, generation, trust, activation, pause-marker and wake behavior remain unchanged. Interrupt retains its existing explicit-pause behavior. Timer return categories are unchanged; this section changes hook reasons only.

The six new tests exercise completion through the real pause method, a stall through four unchanged Stop events, explicit pause, and an active owner with a matching pause marker. Four hooks are checked in each stopped case: SessionStart, UserPromptSubmit, PreToolUse and Stop. Assertions verify refusal, byte-identical owner/marker files and no native calls or queue changes before checking the reason. Further regressions prove foreign/old-generation markers do not revoke the current owner and that completed owners require explicit trusted activation. Existing lifecycle tests retain foreign ownership, generation revocation, racing pause/lock/queue behavior and restart refusal checks.

## Observed local gates

- Failing first: `taskset -c 2 python3 -m unittest tests.scripts.test_codex_continuation tests.scripts.test_codex_lanes` with new tests and original controller ran 43 tests in 0.178s, failing exactly eight completed/stalled reason subtests. Each reached its reason assertion after denial and unchanged owner/queue assertions passed. Paused and matching-marker cases passed. Scratch output: `build/access-s41-before.log`.
- Fixed: the identical command passed all 43 tests in 0.127s.
- Mutation: compiled an in-memory copy of the controller with only the state-specific description expression replaced by the old generic `is paused` value, then ran the four stopped-state tests against that method. Exactly eight completed/stalled reason assertions failed, zero errors; paused/marker cases and enforcement assertions passed. No on-disk controller or live owner was changed. Scratch output: `build/access-s41-mutation.log`.
- `git diff --check` passed.
- `python3 scripts/check-publication.py` passed, 3466 tracked files.
- Pre-implementation graph validation passed with 610 sections; generated plan was current. Commit and final stamp gates revalidate the tree.

No product source, runtime settings, provider, CI, pin, timer or hook definitions changed. No full Worker suite or product build is warranted by these Python reason/doc changes. Local unit/transport tests do not establish native heartbeat, timer delivery, deployment or F2 visibility. Existing §30 and its original receipts are unchanged.

Reversal: revert the description selection and corresponding documentation/tests if required; this restores misleading text without changing denial or ownership semantics. Do not erase review history or receipts.

Layer: ownership controller hook reasons, changed at their source; no workaround.
