# Immutable checkpoint readiness

D03 T04 §52 provides a read-only checkpoint identity handoff. It cannot export a model, deploy, run inference, stop training or authorize rollout. CHECKPOINT-04 permits preparing intermediate testing around measured 60 percent while the existing trainer continues; a percentage alone does not establish a checkpoint or a valid evaluation population.

## Observed checkpoint

At `2026-11-04T08:43:41.965153+00:00`, GET-only provider discovery confirmed `promotable: true` for:

`accounts/rizonetech/trainingSessions/ts-db85d8de82174aa6824b775ca6e40075/checkpoints/run-68d2a96331c54fed9aa8ad2560d4333d-step-1800-7c021c9f`

The matching local checkpoint records step 1,800 and 28,800 examples consumed, out of 72,375 total. This is checkpoint consumption, not the later live trainer percentage. Its owning session and run match the recorded session history. No checkpoint was exported or deployed.

The immutable receipt is `<store>/runs/checkpoint-readiness/loupe-1.1-20261104T0846.json`; its observation timestamp, not its filename label, is authoritative. Auditor commit `f269b175128dc0d2a7c8ac31d682fb87bba159a6`, source SHA-256 `88f937d4edaab4aacbd7a8b1337f339efa5a58d9d56a29dd99289f46c003631c`. Trainer input SHA-256 `5fb1d93b4549bd8b64c69c943ad5f23a7411cdfc8d4d3f2e339f0442d2eb253b` matches the historical selection and §51 audit. Session, local-checkpoint, selection, input, audit and provider-listing digests are recorded in the receipt; snapshot identities stayed stable throughout discovery.

## Evaluation boundary

`comparison_evidence_ready: false`, `paid_comparison_ready: false`, `rollout_authorized: false`. All 17 aggregated audit issues are retained unchanged, including missing 1.1 archive and provenance, incomplete baseline archives and held-out source-item fields, different evaluation digests and cross-version overlap. See [the artifact audit](checkpoint-audit.md). Neither the new checkpoint nor the elapsed training percentage repairs this evidence. §51 remains unstamped after its returned completion gaps, despite subsequent repairs and live remeasurement.

The eval lane and coordinator receive this exact identity and the immutable audit reference. The next permitted action is to establish a valid common held-out population and agree the comparable evaluation harness, identities and accounting. No paid test starts from this handoff alone. Final-model preference remains conditional on evaluation and release gates.

## Operation and recovery

Run `python scripts/glimmer/checkpoint-readiness.py --run <actual-run> --trainer-input <actual-input> --audit <immutable-audit> --live` in the installed Fireworks SDK environment. Live listing reads the existing owner credential through `conclave-op` in memory and uses GET requests only. `--provider-list <snapshot>` is an explicitly labelled offline observation. The default writes nothing. `--receipt <new-path>` publishes only beneath `<store>/runs/checkpoint-readiness/`, outside Git, using an absent-only atomic link and read-back; an existing receipt is never replaced.

Exit 0 means an available candidate, never permission to evaluate or release. Exit 1 means confirmed absence or a named evidence refusal. Exit 2 means discovery unavailable, invalid invocation or publication failure. Credential denial, provider denial, timeout, malformed response and successful empty listing are distinct. Transient errors retain a sanitized Retry-After delay; there is no automatic retry loop. The lane applies its durable coordinator-approved backoff. Concurrent trainer-record updates refuse the observation so a later read can take a fresh snapshot; they do not restart training.

Targeted validation: `python3 -m unittest tests.scripts.test_checkpoint_readiness tests.scripts.test_checkpoint_audit tests.scripts.test_version_gate` passed 59 tests. Ordinary and resumed-session successful handoffs, absent and unavailable discovery, malformed/foreign/ambiguous candidates, changed inputs, concurrent updates and receipt publication are covered. Changed-selection metadata and Retry-After regressions failed before their repairs and passed afterward. These tests and this live observation are not review approval.
