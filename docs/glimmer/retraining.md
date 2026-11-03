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

## Step 2: Process the cleared production capture backlog

Run the teacher labeller over cleared production pages (`D03 T04 §46`, `processProductionBacklog` in `scripts/glimmer/store.ts`) and apply offline Astra and Wonder judgements (`applyJudgements`) until the review queue is empty for the candidate version.

## Step 3: Freeze and build the versioned training split

Freeze the store for the target version (`freezeFile(store.dir, version)`) and build the Fireworks JSONL training and validation files (`docs/glimmer/training.md`), holding out the frozen evaluation hashes (`docs/glimmer/eval-hashes.txt`).

## Step 4: Fine-tune and evaluate on the held-out set

Launch the LoRA fine-tuning job on Fireworks AI and evaluate the resulting adapter against the held-out benchmark before promoting the model ID in production.
