# Loupe Retraining Runbook

Every Loupe retraining run builds a new version of our tuned Muse Glimmer 30B page screener from the local Glimmer store (`~/isitlegit-data/glimmer`, overridden by `GLIMMER_DATA_DIR`).

## Step 1: Export monitor-labelled pages from R2 `training/`

Before freezing or building a dataset, pull every newly settled monitor training copy (confirmed lures from D05 T04 §4, Spark-declined flags from §9, and business dismissals or retractions/removals from §5 and §10) into the local store and verify all stored `monitor` pages:

```sh
node scripts/monitor-export.ts --for-retraining
```

Programmatic callers invoke `exportBeforeRetraining(bucket, store)` from `scripts/monitor-export.ts`. The step:

1. Reconciles any `removed.json` tombstones and `retracted` findings against the local store (`removePage` / `keepItems` and `revokeProductionAdmission`).
2. Exports each completed `training/monitor/<org>/<host>/<fetchedAt>/` copy (`done.json` present) through `store.putPage("monitor", ...)` with `origin: "production"`, boolean `labels: { lure }`, and `label_source: { lure: "rule" }`, recording shared-content provenance with `store.addItem` and verifying read-back with `store.readVerifiedPage`.
3. Refuses to proceed if any R2 copy fails a transient read or if `store.verify("monitor")` reports a damaged local page, and writes `<store>/monitor-export-status.json` (`"state": "ok"`).

Dataset creation scripts or offline gates that run without R2 network credentials verify that Step 1 succeeded recently (`state === "ok"`, within 36 hours, and `store.verify("monitor")` clean) by calling `assertFreshMonitorExport(store)` or running:

```sh
node scripts/monitor-export.ts --check-fresh
```

## Operator procedure: removing a host at a business's request

When a protected business asks for a monitored host or dismissed domain to be removed from Loupe's training corpus (D05 T04 §10; privacy disclosure at `/privacy`), run the scoped host removal command:

```sh
node scripts/monitor-export.ts --remove-host <orgId> <host> --reason "removed at the business's request"
```

Programmatic callers invoke `removeHostTrainingData(bucket, store, receipts, save, orgId, host, reason)` from `scripts/monitor-export.ts` (or `removeTrainingCopiesForHost(bucket, orgId, host, reason)` in `src/monitor/training.ts` inside the Worker). The command:

1. Writes `removed.json` tombstones at `training/monitor/<orgId>/<host>/removed.json` and under every known capture prefix `training/monitor/<orgId>/<host>/<fetchedAt>/removed.json` in R2.
2. Deletes every screenshot, text, metadata, and completion marker object under `training/monitor/<orgId>/<host>/` in R2.
3. Reconciles the local Glimmer store immediately (`removePage` or `keepItems` on shared content, `revokeProductionAdmission`, and `"outcome": "removed"` in `monitor-export-receipts.json` and `monitor-export-skips.json`).
4. Verifies that zero non-tombstone R2 objects and zero local `manifest.jsonl` items remain for `monitor/<orgId>/<host>/` before returning `"verifiedEmpty": true`.

## Step 2: Process the cleared production capture backlog

Run the teacher labeller over cleared production pages (`D03 T04 §46`, `processProductionBacklog` in `scripts/glimmer/store.ts`) and apply offline Astra and Wonder judgements (`applyJudgements`) until the review queue is empty for the candidate version.

## Step 3: Freeze and build the versioned training split

Freeze the store for the target version (`freezeFile(store.dir, version)`) and build the Fireworks JSONL training and validation files (`docs/glimmer/training.md`), holding out the frozen evaluation hashes (`docs/glimmer/eval-hashes.txt`).

## Step 4: Fine-tune and evaluate on the held-out set

Launch the LoRA fine-tuning job on Fireworks AI and evaluate the resulting adapter against the held-out benchmark before promoting the model ID in production.
