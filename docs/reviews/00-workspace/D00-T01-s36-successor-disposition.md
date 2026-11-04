# D00 T01 §36 scoped successor disposition

Original plan: fd3c2439fdc80933358c7505bb14d4ec8899b773, corrected before implementation at 182242a809671f202306bd9755ded6f501915f4e. Original combined completion: 39bd5ca172c5439082fc09d660c1904dd6cbe7ec, digest b59a8196281091b9, gaps. First reconciliation: 688a0fdc575bbd246ac56a9ab110576f33283bf5, digest bd520ac7d1311303, gaps. Original report docs/reviews/00-workspace/D00-T01-s36.md is append-only; neither failed verdict has been rewritten.

## Original findings and repairs

1. Original completion P2: a restored plan-only report could hide committed attempts. The first reconciliation verified this repaired. Preserve that result and historical checks at dispatch and replay, including real incoming MERGE_HEAD history and known-outage retention.
2. First reconciliation P2: after committing a valid reconciled legacy transition, replay incorrectly compared full historical evidence with the immutable original prefix, which intentionally excludes the reconciliation. Repair in `_reconcile_chain` retains exact prefix parsing and adds full current-report context for history validation. A real-Git test transitions the legacy plan, records combined gaps, records reconciliation, commits it, then proves replay succeeds. It failed before the fix with the exact removed-attempt refusal. Deleting the committed reconciliation still refuses, and restoring exact bytes succeeds.
3. During successor implementation, the coordinator found a real normalization defect before another review call: pending raw reviewer links can be absolute while stored findings canonicalize them to repository-relative paths. The predecessor comparison now uses the same `repository_relative` normalization as recording and recovery. The durable extension regression with an absolute checkout link failed before the fix and passes afterward. No error or review output is discarded.

## Explicit bounded authorization

AGENTS.md records a new coordinator decision after the first returned reconciliation gap, a case expressly left for such a decision by the prior policy. The committed pin authorizes one successor only for this canonical report and predecessor digest bd520ac7d1311303. This does not add a normal review or extend other sections' default one-pass reconciliation allowance.

Version 2 evidence binds the full preceding findings prefix, exact predecessor digest/candidate, original approved contract, same-or-descendant repair candidate and committed disposition. Dispatch, durable recovery and receipt replay validate that authorization from the recorded committed pin. A third returned reconciliation, wrong/missing permission, successful predecessor, removed evidence or stale candidate refuses. Known outages retain the same binding; predecessor journals are archived and atomically replaced, not deleted. Old version 1 bindings and receipts retain their interpretation. No completion or safety requirement has been narrowed.

## Verification

The complete dispatcher suite passed 154 tests with one skipped in 68.690s. After the normalization correction, all 23 reconciliation tests passed, including durable successor archival/recovery, exact-prefix preservation, absent/wrong authorization, stale candidate, third-return refusal and known-outage retry. Graph, launcher, continuation and health suites passed 293 tests in 70.283s. The graph successor test failed before support, then proves a genuine scoped two-reconciliation receipt stamps, survives commit/replay and refuses when its successor evidence is removed. Actual test outputs are retained in coordinator handover logs. Design check reported zero problems. Local test results are not CI, deployment or model release evidence.

## Other authorized intervening work

HEALTH-28 adds read-only lane observability and an ExecStopPost health report on the existing five-minute host timer, including failed heartbeat ticks. It never wakes or restarts a lane, bypasses a stop, changes effort or creates a scheduler. Eleven snapshot tests and the existing continuation suite cover the behavior. Live inspection observed all eight lanes without native-read errors; the first installed service invocation succeeded. Scheduled recurrence is still being measured, not inferred from installation. This remains the explicitly named systemd workaround, not a native Codex recurring job.

LANES-19/25 launched two exclusively assigned worktrees on the previously verified setup while this tooling repair continues; product implementation and final-review gates are separate. Both owners have native session IDs and guarded activation. D07 T02 §30's exact previously approved companion is incorporated in A1 by the coordinator; its owning Access lane implements and tests the surface. The design check passes. No unrelated console code was imported into main, and the access branch cannot be merged wholesale as approval of its unstamped ancestors.

Reviewer settings remain the operator-approved plan low, combined medium and reconciliation medium. Models and lane writer effort remain unchanged. Training, media render/publication hold, protected data and submission deferral are untouched. No fabricated receipt, manual stamp or bypass is authorized.
