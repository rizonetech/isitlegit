# D00 T01 §44 implementation evidence

2026-11-04: The owning review dispatcher now supports only the exact dormant Muse plan transition named by §44. Original writer, null policy, candidate, pin, nine findings and contract remain bound. No production pin or live migration authorization was changed. Root retains separate activation authority.

The genuine plan P2 (digest `89f299d360b75756`) was accepted and the contract corrected before implementation at `24f974fe7`. New real-Git tests exercise the requested combined gaps, bounded reconciliation, same-result recovery, stamp and committed replay after revocation. Reconciliation gaps cannot stamp.

Failing-first evidence: `/tmp/muse-transition-red.log` records the initial positive lifecycle refusal before capability implementation. `/tmp/muse-transition-revocation-red.log` records acceptance of an uncommitted previously authorized pin after committed revocation before the owning new-call check was repaired. New calls now require the pin committed at HEAD; historical replay and recovery keep their original authorization.

Final gate: `taskset -c 0,1 python3 -m unittest scripts.tests.test_review_dispatch tests.scripts.test_todo_graph` passed 436 tests in 215.027 seconds, one existing skip (`/tmp/muse-transition-final-full.log`). The focused migration/graph lifecycle suite passed 14 tests (`/tmp/muse-transition-final-targeted.log`). Tests cover original Muse route and schedule, strict identities/schema/prefix/contracts, removed attempts, unrelated candidates, explicit authorization, revocation, uncertain calls, known outages, immutable returned-result recovery and receipt tampering. Original Codex transitions and reconciliation suites remain green.

`python3 scripts/todo-graph.py validate` passed 611 sections (`/tmp/muse-transition-validate.log`); `plan --check` reported plan current (`/tmp/muse-transition-plan.log`); `python3 scripts/check-publication.py` reported clean (`/tmp/muse-transition-publication.log`); `git diff --check` passed. These are local tooling tests and source evidence, not production acceptance of D08 T02 §3.

Layer: review authorization and provenance are owned and changed in the dispatcher, with lifecycle and graph regressions and policy documentation; no workaround.
