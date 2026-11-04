# D03 T04 §52 completion-gap disposition

Prepared 4 November 2026 at the coordinator's explicit direction. This is the writer's disposition for future bounded reconciliation, not a review receipt, approval or stamp.

- Original findings: `docs/reviews/03-vision/D03-T04-s52.md`.
- Original completion candidate: `54df5704f5eb21516e4e7dece82dd70263c8daa3`.
- Original completion digest: `efd7d81333438cc8`.
- Original pin: `0bb45776a2b27198b4bb6e41128b2ff411cac1e7`.
- Preserved findings file SHA-256 before reconciliation: `d6aed72a81c7d737ce0d5242bdc66e43fd37c96715c5f32f32349cbcb17d6aca`.
- Historical repair commit: `afb3178e6b693b73db6b258ceff8ae035fcc4b13`. This is repair evidence, not the eventual candidate incorporating verified shared tooling.

## Every original completion gap

1. Original Part 1 item 6 / combined gap 1: receipt directory publication lacked crash durability. This is an in-scope persistence defect. Repair synchronizes the directory after linking and before read-back/success. Regressions `test_receipt_directory_is_synced_after_link_before_readback` and `test_directory_sync_failure_never_reports_success` in `tests/scripts/test_checkpoint_readiness.py` failed before repair and pass after it.
2. Original Part 1 item 7 / combined gap 2: failed-audit coverage was missing. This is an in-scope test requirement. `test_failed_audit_retains_blockers_and_denies_permissions` now verifies failed status, every blocker and denied comparison/paid-test/rollout permissions. This closes missing coverage; it is not represented as a previously reproduced runtime bug.
3. Original excellence item 1 / combined gap 3 duplicates the durability requirement in item 1 above and is resolved by that same repair and evidence, not omitted or classified optional.

Recorded gate: `python3 -m unittest tests.scripts.test_checkpoint_readiness tests.scripts.test_checkpoint_audit tests.scripts.test_version_gate`, 62 tests passed. GET-only external handoff `runs/checkpoint-readiness/loupe-1.1-20261104T0853.json` observed the actual step1800 provider checkpoint and preserved all audit blockers with permissions false. Availability is not evaluation validity or rollout approval.

## Acceptance boundary

All original gaps are accepted as mandatory. No additional suggestion is substituted for a defect, and no obligation is removed. Original plan, single regular round, failed completion, pins and candidates remain unchanged. The coordinator owns release of the supported reconciliation command and pin. A future reconciliation must inspect the full intervening diff and all original obligations at its exact candidate; this document and passing tests alone do not authorize stamping. No reconciliation has run for this section.

## Released tooling and intervening candidate changes

Original plan candidate: `39c80c251b3dd591babeb67df405c47a864b0e5e`; its immutable findings and plan-gap dispositions remain in the canonical findings file. This disposition supplements the prior preparation after verified coordinator release REVIEW-ROLLOUT-36.

All intervening commits through setup `d40b97adcd935a8e6bf547747e78ba6c669d84a8`, in order:

- `afb3178e6b693b73db6b258ceff8ae035fcc4b13`: glimmer: make checkpoint handoff publication durable.
- `0b0af98b5e864269265bbb85bc21994f0b6a5924`: todo: prepare pinned download mode plan for Codex.
- `7fb966f7cbfbdb8a1dea3d02888ce5946b76aa55`: todo: close pinned download provenance and recovery gaps.
- `1250d1dd4f5552746ec0cf1eb1b17dcb15025119`: glimmer: a pinned download mode for sources with no published digest.
- `648c764510a0ba016325e876302d8add0cdffcf7`: glimmer: recover pin initialization and preserve legacy manifests.
- `ba850799c1c469a2d37c7819f66fbb9b0778201a`: glimmer: bind Hugging Face cache redirects to pinned artifacts.
- `1d930af4b18ea5fcb78974c0ba8a4c85d91d9d09`: docs: bind Loupe completion gaps to their repairs.
- `d40b97adcd935a8e6bf547747e78ba6c669d84a8`: Sync verified coordinator review tooling release.

The intervening offline sections 51, 52 and 42 retain their own contracts and original review histories. Shared tooling is the coordinator-authorized exact 23-file snapshot from `e4401838e1a23986f2536fc6d71d4811b883c8b7`; its local 447 tests passed with one skip, graph validation passed 600 sections and publication scan was clean. No product runtime, trainer input or evaluation population changes are part of these repairs. The trainer-owned uncommitted progress file is excluded from the isolated candidate. The reconciliation reviewer must inspect the full original-completion-to-candidate diff, including these intervening changes, against unchanged original obligations.

## Returned reconciliation gap, 4 November 2026

The first returned reconciliation on `5f1043fa79fc455c911a6f8564f58059c9cc2484` reports a mandatory P2: directory creation was not durable through newly created ancestors. Its original completion gaps 1 and 3 remain the same obligation; gap 2 and plan findings are resolved. The actual gaps verdict is preserved in the canonical findings. No repeated reconciliation is authorized without a new exact coordinator decision.

Repair synchronizes the receipt leaf and every ancestor through the filesystem root after absent-only linking and before read-back. Synchronizing existing ancestors too covers a retry after an interrupted directory creation. Any synchronization error refuses success and preserves the uncertain receipt without overwrite. Two readiness regressions fail before repair and pass afterward: `test_new_nested_receipt_ancestors_synced_leaf_to_root` and `test_ancestor_sync_failure_refuses_acknowledgment`. The existing ordering regression now requires every directory synchronization between link and read-back.

The adjacent audit publisher had the same defect; two equivalent audit regressions also fail before its repair and pass afterward. That post-stamp repair does not change or claim coverage from the historical section51 stamp. Coordinator must determine its acceptance coverage. Actual combined gate: `taskset -c 4,5 python3 -m unittest tests.scripts.test_checkpoint_readiness tests.scripts.test_checkpoint_audit tests.scripts.test_version_gate`, 66 tests passed in0.254seconds. Local before/after logs are in `build/s52-ancestor-before.log`, `build/audit-ancestor-before.log` and `build/loupe-ancestor-after.log`. These fixes are not approval.

## Exact scoped successor authorization

Coordinator LOUPE-S52-SUCCESSOR at2026-11-04T11:34:44.465266+00:00 authorizes one successor bound to failed digest `1a6c0d8e3ba2dd96`. The prompt and verification must cover BOTH `scripts/glimmer/checkpoint-readiness.py` and `scripts/glimmer/checkpoint-audit.py`, including `test_new_nested_receipt_ancestors_synced_leaf_to_root` and `test_ancestor_sync_failure_refuses_acknowledgment` in each corresponding test module. Verify leaf-to-root ordering before acknowledgment, propagation of any ancestor error, `finally` descriptor cleanup, absent-only publication and retained immutable history. These adjacent audit repairs fulfill section52's existing audit-durability comparison obligation. Historical section51 stamp remains limited to4ab06332 and is not altered. Missing audit-path coverage leaves that repair unaccepted. The authorized pin addition names only this exact predecessor; no third returned reconciliation is authorized.

The later REVIEW-JOURNAL-HOLD prohibits invoking this successor until the coordinator releases the reviewed journal ancestry repair. This disposition and the pin entry prepare the allowed route; they do not bypass that hold or approve the candidate.
