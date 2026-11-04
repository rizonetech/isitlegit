# Immutable per-case ablation

Coordinator assignment: `critical-path-contract`, 4 November 2026, 09:32:50 SAST. Checks owns intake/persistence and pipeline consumers; eval owns orchestration/reporting in D08 T02 §17. Migration 0095 is reserved to checks. This design changes no product safety boundary and authorizes no live arm before reviewed hooks are stamped, merged and deployed.

## Wire contract

Agreed with eval in `eval-ablation-wire-agreed`, 4 November 2026. `POST /api/upload` accepts one file, one textual `replayRunId` and one textual `ablate` JSON object for an experimental upload. The object has exactly `experimentId`, `arm`, `manifestDigest` and `deployment`. `experimentId` and `replayRunId` match `^[A-Za-z0-9_-]{1,64}$`; `arm` is `full`, `no-agent-reasoning`, `no-walkthrough`, `no-sam`, `no-transcribe` or `no-screening`; digest is 64 lowercase hexadecimal characters and deployment is 40 lowercase hexadecimal characters equal to the running `COMMIT_SHA`. Unknown keys, malformed JSON, non-text, duplicate fields and ablate without replay identity are rejected before admission. Ordinary uploads and replay-only uploads retain their current contract.

The manifest digest is SHA-256 of UTF-8 `JSON.stringify({seed,sets,setVersions,deployment,ids})`, with those property positions, sets and IDs in manifest order, and setVersions keys inserted in sorted order. Mutable arm status/runId and experimentId are excluded. The runner owns computing and preserving it; the server binds the supplied digest immutably and does not claim to have received or independently validated the population itself.

Only a signed-in member of the exact configured `EVAL_ORG_ID` can submit any ablation metadata. A non-eval organisation gets 403; malformed fields get 400; a deployment or immutable identity conflict gets 409. These refusals create no case, file or Workflow. Existing daily limits, replay deduplication and model budget accounting still apply. No flag or experiment identity comes from a model or organisation-wide KV.

## Durable identity

Migration `0095_case_experiments.sql` adds three tables without rebuilding cases:

- `eval_experiments(org_id, experiment_id, manifest_digest, deployment)`: immutable manifest binding, primary key organisation and experiment ID.
- `eval_experiment_arms(org_id, experiment_id, arm, replay_run_id)`: one immutable replay ID per experiment/arm and one binding per organisation/replay ID.
- `case_experiments(case_id, org_id, experiment_id, arm, replay_run_id)`: one immutable attribution per case, foreign keys to its arm and case.

Deletion follows organisation/case retention through foreign keys. Updates cannot change identity. The normal intake claim remains keyed by organisation, replay ID and upload content/name/type identity, so the same arm/sample retry returns the same case and different arm replay IDs produce fresh cases. A reused replay ID with different experiment, flag, digest or deployment is refused, not treated as a duplicate. Conflicting concurrent reservations have one winner and one explicit conflict.

Bind the experiment and arm before any case admission. Persist case attribution before storing its raw file and before starting its Workflow. If attribution persistence fails, no raw file is written and existing intake recovery settles the case as an incomplete admission. A stored file therefore implies durable experiment attribution; a sweep can start from case ID alone. Retry, sweep and Workflow resume never reread a caller-supplied or KV flag.

Both successful admission and duplicate responses include `experiment: {experimentId, arm, manifestDigest, deployment, replayRunId}` read from D1. Ordinary responses omit it. Eval's existing direct-D1 reader joins the three tables by organisation/experiment/arm and reads by case ID; another organisation cannot obtain this through the authenticated upload route. Read or schema failures are errors, never an unflagged experiment. A resumed experimental case on a different deployment cannot spend against an incomparable arm.

## Consumers and accounting

D01 T03 §17 owns the strict schema, admission, immutable tables, recovery and read-back. D04 T01 §17 owns case consumers: reasoning, walkthrough, SAM and voice transcription. It replaces KV reads with durable case context and proves a neighbouring ordinary case is unaffected. D04 T01 §18 owns the separately triggered labelled-page screening experiment; an uploaded case without screening is never measured as a Loupe removal.

- `no-agent-reasoning`: skip the verdict agent and its preparation; use the rule verdict with deterministic actions, existing evidence citations, partial-coverage warnings and the deterministic floor unchanged. Other Spark uses still run.
- `no-walkthrough`: no browser/model walk or reused cached walkthrough result; retain the explicit ablated evidence and all other steps.
- `no-sam`: no segmentation or logo comparison through the vision step, agent tool executor or verdict tool dependencies; retain other vision reading and explicit coverage/ablation markers.
- `no-transcribe`: for uploaded audio and audio attachments, skip transcription and dependent voice extraction before decoding/model calls, including cached transcript/claim reuse; persist explicit not-checked voice evidence attributable to the experiment. Other evidence and final deterministic rules still run.
- `no-screening`: use the labelled monitor experiment binding to skip Loupe wake/inference and call the existing Spark fallback for each selected page, with result and spend attribution. Do not turn screening off and do not claim ordinary uploads exercise this path.

All retained model calls use the same runtime ledger, budgets, standard IDs and `store: false`. Tests stub model transports and cannot spend. A failed attribution read must not be caught as null and silently execute a different arm; resolve immutable context before starting model-dependent work. Historical ordinary cases have no experiment row and retain normal behavior. Organisation KV keys cannot change their behavior.

## Verification and rollback

Intake tests prove each accepted arm and explicit full baseline, exact D1 read-back after resume/sweep, retry identity, different-arm fresh cases, immutable/concurrent conflicts, malformed/forged refusals before side effects, unchanged ordinary upload/replay and preserved daily cap. Consumer tests count skipped and retained calls on each applicable path, cross-case isolation, metadata outages, deployment mismatch and persisted ablated evidence; frozen floor/citation tests remain unchanged. Screening has a separate trigger/attribution contract before implementation and live comparison. Eval orchestrates only after all required receipts and exact deployment agree.

Rollback disables experimental uploads at their intake capability, stops new eval arms, and preserves recorded attribution/results; it never converts existing experimental cases to ordinary cases or erases accounting. The schema is additive, so no table rebuild or production-data deletion is needed. Returning to organisation-wide flags is not a rollback option because it loses immutable arm identity.
