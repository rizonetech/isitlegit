# D00 T01 §36 completion finding disposition

Original approved plan: fd3c2439fdc80933358c7505bb14d4ec8899b773, with the three accepted plan corrections committed at 182242a809671f202306bd9755ded6f501915f4e before implementation. Original combined completion candidate: 39bd5ca172c5439082fc09d660c1904dd6cbe7ec. Original report: docs/reviews/00-workspace/D00-T01-s36.md, retained unchanged through its returned COMPLETION: gaps. This is a real defect repair, not a scope exception or a replacement verdict.

## Original blocking finding

P2: restoring a plan-only report could hide a committed historical round or completion attempt and incorrectly qualify the chain for a zero-round transition. The original §36 contract explicitly requires proving that no intervening review attempt was discarded. No other blocking finding or additional suggestion was returned.

## Owning-layer repair

The dispatcher now validates reachable report history at transition binding creation and receipt replay. It resolves actual HEAD and MERGE_HEAD identities, scans deduplicated historical report blobs, and matches the same original sealed plan identity. A historical ordinary round, final or legacy completion attempt refuses transition even after a later restoration drops it. A previously committed modern completion or reconciliation must remain in the current report with its original identity. An unrelated older plan does not block this chain. Retained authorized modern outage history still supports the existing known-outage retry. Immutable history caching uses resolved commit identities, not mutable branch names.

The original plan, combined completion, failed verdict, pins and findings are not rewritten. The approved contract and product safety obligations are unchanged. There is no extra normal review: only the explicit bounded reconciliation may verify this repair.

## Falsifiable evidence

Three new real-Git regressions were observed failing before the fix: a committed legacy round followed by plan-only restoration incorrectly invoked the fake reviewer; a removed legacy completion reachable through MERGE_HEAD was accepted; and a removed modern result could start another transition. They now refuse. The first also proves receipt-chain replay refuses the same omitted attempt. Positive tests retain a committed transition outage through retry/replay and accept unrelated original-plan history.

Targeted dispatcher tests: 43 passed, including 20 two-pass, 17 reconciliation and six legacy Codex tests. The actual fake-CLI capture verifies model_reasoning_effort=medium for combined reviews under the approved EFFORT-22 setting. Full checkpoint: `taskset -c 0,1 python3 -m unittest scripts.tests.test_review_dispatch tests.scripts.test_todo_graph tests.scripts.test_codex_lanes` passed 405 tests in 106.600s with one skipped. Actual output is retained at ~/isitlegit-data/handover/s36-repair-tests.log. Existing temporary-directory ResourceWarnings remain visible; no error output was suppressed. Graph validation passed 602 sections, publication scan was clean and diff whitespace validation passed.

## Other intervening changes

Operator EFFORT-22 keeps plan low and changes combined completion and reconciliation from low to medium in .conclave/reviewers.toml. Reviewer models and lane writer efforts are unchanged. The original combined review remains truthfully recorded at low because it started before that approval.

Operator LANES-19 transfers D07 T02 §30 from console to access and D02 T05 §7 from checks to detection-eval in todo/lanes.json after both owners released the sections. Separate checkouts and handovers are prepared, no writer activated yet. This allocation neither imports unrelated lane product code into main nor changes §36 obligations. No CI, deployment, native heartbeat or product-release claim follows from these local changes.
