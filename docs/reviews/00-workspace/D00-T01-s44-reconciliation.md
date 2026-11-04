# D00 T01 §44 completion finding disposition

2026-11-04: Accepted the sole genuine P2 in completion digest `583039b7e0e28d99` on `064560de2c19bb053098e628cf14e445cd944f3c`. The original review remains failed and byte-preserved. The original plan at `5031c3ea0d5e2aece13ba71430206ba7a0c872dd`, its nine product obligations and all tooling obligations remain unchanged. No live migration authorization is installed.

Requirement and defect: known-outage retries must preserve the exact migration binding. The original builder accepted a different reachable descendant candidate with unchanged section obligations. This is an in-scope defect, not optional scope.

Repair: `make_completion_binding` now compares the entire proposed Muse binding to every prior completion attempt before dispatch. `validate_completion_binding` enforces identical Muse bindings across all attempts during recovery and receipt replay. Existing version 1 Codex behavior and schema remain unchanged. Pending journals, original reviews and pins are preserved.

Falsifiable proof: `test_outage_retry_cannot_switch_candidate_before_invocation_or_replay` failed before the fix because the changed-candidate call did not refuse (`/tmp/muse-transition-outage-red.log`). It now proves a reachable descendant with unchanged obligations refuses before any reviewer invocation, a recorded changed-candidate result refuses chain validation, and retrying the original candidate succeeds once with the entire original binding unchanged. The focused 15 migration and receipt lifecycle tests passed in 9.821 seconds (`/tmp/muse-transition-outage-green.log`).

Affected full gate: `taskset -c 0,1 python3 -m unittest scripts.tests.test_review_dispatch tests.scripts.test_todo_graph` passed 437 tests in 194.973 seconds, one existing skip (`/tmp/muse-transition-repair-full.log`). TODO validation passed 611 sections, plan check reported current, publication clean (`/tmp/muse-transition-repair-validate.log`, `/tmp/muse-transition-repair-plan.log`, `/tmp/muse-transition-repair-publication.log`). The original source evidence remains in `D00-T01-s44-implementation.md`.

No finding was waived and no new ordinary review is requested. This disposition supports the first bounded reconciliation only; it is not approval.

Layer: the review dispatcher owns and now enforces exact migration retry identity in construction and replay; no workaround.
