# D08 T02 §3 exact historical plan migration disposition

Prepared 2026-11-04 by explicit coordinator instruction after tooling stamp `74228085ce464ccdacb12cdbd4ccaaced0e4092e`. This committed document prepares an auditable migration package only. It is not an activation, review approval, completion claim, paid-run authorization or waiver. The coordinator must separately audit and authorize installation of the pin entry before the existing detection-eval owner proceeds. No new plan or ordinary review is fabricated.

Original plan: writer muse, null policy, candidate `46f30018c9b502c91f9793448d0b83912655d23d`, pin `ce29c18a398871b473c634630dbf588c04ec5ef2`, digest `eacaec74ce2afc03`. The complete report prefix, original nine findings and original contract remain immutable. The accepted current section contract is taken unchanged from integrated base `49742cb8bdc1b3ec0abf974ace2da512ddc85c4a`, combining corrected gate `de606a611952c4ffa51e57549ebe6e4d015e6d7a` (already containing runner `e418f32c2fb8cd9d08748ae4bfdbd2e75d3a34e0`) and stamped migration tooling. No runner rebuild or product source change is included.

The following dispositions preserve the detection-eval owner's proposed evidence and remaining work. Source locations cite `e418`; the package manifest proves that the existing runner is unchanged. Historical measurements remain historical. All items labelled remaining proof or work are mandatory acceptance gates, not optional deferrals. In particular finding 3's labelled monitor experiment remains required, and finding 6's metrics/manifest selection and matched `ablate:full` publication defects remain assigned to detection-eval's existing section 3 implementation slice after root activation. No review may claim the entire section complete while these or live evidence requirements remain unmet.

## Findings preserved for implementation and final acceptance

### 1. P1: server-side flag admission has no assigned owner

Proposed disposition: ownership and source implementation supplied by existing D01 T03 section 17 and D08 T02 section 17; retain deployed acceptance as open. At e418, src/pipeline/case-experiments.ts:19 validates eval membership, strict metadata and deployment; :32 reserves immutable experiment/arm identity; :94 reads case attribution. src/intake/upload.ts and migration 0095 implement admission and persistence. eval/run.ts:272,572,613,829 transports and validates the same attribution. test/intake/ablation-upload.test.ts:70,97,119,155,184,227,247,277 covers fresh arms, duplicate recovery, forged/malformed input and storage/schema failures; test/node/eval-ablation-transport.test.ts:32 covers the wire path.

Remaining proof: root-approved integrated baseline, successful release/migration gates, exact serving capability and persisted D1 identity readback, including recovery. Do not implement another admission path or claim source tests prove deployment. Intended owners remain Checks for admission and detection-eval for the existing section 3 acceptance/reporting slice after activation.

### 2. P1: runner plumbing conflated with hook effectiveness

Proposed disposition: preserve the distinction and reuse existing, separately owned tests. At e418, test/node/eval-ablation-transport.test.ts:287 exercises the command with injected clients; test/pipeline/ablation-consumers.test.ts:116,148,373,385 and its parameterized arm cases cover durable context, suppressed calls, unaffected ordinary cases and failure propagation. D04 T01 section 17 owns the production consumers, implementation a6a30c332d034d413e95df437b71321d5c3571e4.

Remaining proof: the exact integrated/deployed hook set and actual model-call attribution on the matched experiment. Node transport success is not consumer effectiveness; consumer fixtures are not measured live contribution. Retain the live prerequisite and ordinary-case safety tests. No new hook implementation is proposed.

### 3. P1: upload screening experiment does not reach Loupe

Proposed disposition: real unresolved cross-lane dependency, not resolved by upload refusal. At e418, eval/ablation-experiment.ts:198 refuses no-screening before upload and eval/ablate.ts:299,309 restricts upload capabilities. The labelled monitor proposal remains in handover/eval-ablation-digest-monitor-contract.md:35 onward, owned by Checks D04 T01 section 18 with root decisions for registry publication and migrations.

Remaining work/proof: actual labelled immutable capture population, trigger, baseline and Spark replacement, namespace, per-page results/spend attribution, and the owning reviewed/deployed experiment. Upload results must continue to say Loupe screening not measured. Root must retain the original section 3 blocker or record an explicit supported scope decision; this proposal neither narrows the original requirement nor reclassifies it as optional.

### 4. P1: no matched baseline or reproducible selection

Proposed disposition: reuse source repair, retain actual experiment acceptance. At e418, eval/ablate.ts:45 provides deterministic stratification, :320 the canonical population digest and :337 strict manifest validation. eval/ablation-experiment.ts:239-278 fixes exact selected IDs, versions, deployment and sample bytes; :157 computes per-set figures. These preserve challenge separation and refuse drift.

Remaining proof: freeze one actual selected manifest on the authorized deployment and reconcile its exact rows across full and every admitted arm, with failed/unmeasured rows retained and denominators neither dropped nor double-counted. Preserve absent-denominator behavior, including no genuine Nazario rows. No new sample population, selection run or manifest was generated for this disposition. Publication must consume these exact IDs and digest, not reconstruct the old prefix selection (finding 6).

### 5. P1: successive switches may reuse the first arm's cases

Proposed disposition: reuse durable fresh-arm identities instead of recreating the older 24-hour wait workaround. At e418, eval/ablate.ts:402 creates distinct arm replay IDs; :424 refuses immutable identity/cap changes. eval/ablation-experiment.ts:290-338 reads/resumes existing arms without new identities. test/node/eval-ablation-transport.test.ts:326,339,350,361,371,385 covers ambiguous insert, lost response beyond 24 hours, definitive RawMissing replacement and unknown binding refusal. src/pipeline/case-experiments.ts:106 and admission tests:84,97 bind the active sample to the arm.

Remaining proof: an actual same-arm retry must reuse its case, separate arms must have distinct case/replay identities, and ambiguous work must reconcile without a second paid case. Preserve interrupted manifests and attribution history. The eventual committed disposition should explain the existing reviewed section 17 replay mechanism as satisfaction of the original either-replay-or-wait requirement, without editing the original review or manufacturing a retrospective stamp.

### 6. P1: run/report acceptance permits an unmeasured implementation

Proposed disposition: partial source repair exists, concrete metrics/publication work and live evidence remain open. At e418, eval/ablation-experiment.ts:104-155 verifies stored results, active attribution, verdicts, costs and run identity; :157 computes per-set counts and unit cost; :355 writes local RESULTS only. Transport tests:305,427,447 exercise mean cost, ledger alteration and stale/null refusal. No live measurements or comparable public reports are established by these tests.

Intended detection-eval owning slice after verified route/baseline: adapt the existing metrics/publication consumer to experiment manifests and matched full/removed arms. Concrete mismatch: eval/metrics.ts:708-725 reconstructs prefix selection and compares the old setVersion, while experimental runs store manifestDigest and exact stratified IDs (eval/ablation-experiment.ts:318-329). eval/publish.ts:221 preserves ablate:full, while src/eval/results.ts:9 selects a mode-full headline; merely publishing current arm rows cannot provide the intended matched experimental baseline. Keep stored ablate:full and durable attribution intact; do not rewrite run mode to evade validation or disguise an experimental baseline as unrelated production history.

Proposed acceptance tests for that existing slice, subject to root activation: reconstruct exact manifest selection and challenge/main denominators from stored experiment identity; reject altered counts, digest, selected IDs, deployment, stale rows and null verdicts; verify exact hand-computed deltas; publish reconciled compatible reports into eval_published and show them against their matched experiment baseline without replacing an unrelated headline baseline. Verify publication failure/retry retains prior valid reports and no payload/identity data leaks. The exact representation remains a design choice for the authorized implementation; this proposal is not an approval to choose or write it now.

Remaining live obligation: real command execution, every admitted arm's reconciled results and public readback with measured or explicit incomplete/not-measured status. A heading or a local table is insufficient. No claim that this finding is closed.

### 7. P2: orchestration/report failure and recovery requirements missing

Proposed disposition: reuse the existing source and tests; preserve runtime budget and recovery gates. At e418, eval/run.ts:357 checks estimate, stated per-arm cap, shared headroom and allowance; :520 rechecks shared accounting; :545 reserves concurrent estimates before await. eval/ablation-experiment.ts:51 locks the experiment and saves stable identity before dispatch. eval/results-file.ts:36 serializes merge, synchronized temporary writes, atomic replacement and readback. Transport tests:398,427,463,492,553 cover headroom, accounting drift, exclusivity and write/restart failure.

Remaining proof: verify the actual authorized local/deployed cap settings, current shared usage/reservations and allowance before any eventual paid action, without increasing caps or resetting accounting. Preserve uncertain work and resume the same IDs. Extend only the future metrics/publication slice's affected failure tests when authorized; do not rebuild the existing orchestrator. No physical power-loss or fresh runtime accounting proof is claimed. Review the shared-budget scope on the exact activated candidate, not stale values from this checkout.

### 8. P2: impersonation report omits detection measurement

Proposed disposition: retain the existing historical report as historical evidence with explicit coverage limits. docs/phase-runs/2026-11-01-eval-phase-4.md:82 records 275 cases, 265 measured rows, per-category rates, 0/100 false flags, family-only versus corroborating findings, 16 family-only promotions and redirect evidence on 95/275 cases. eval/ablate.ts:122 and its tests classify standalone versus corroborating checks. The prior report names categories below target.

Remaining proof/qualification: carry exact counts, failed/unmeasured denominator treatment and the historical source identity into the final section disposition. Existing redirect evidence proves only its observed subset; absent redirects do not prove a clean follow ran or failed. Any current-population claim requires its own stored evidence and network coverage readback. Do not substitute a family-check count for a verdict-change count, or present old results as an e418/live-ablation measurement. Root/final supported review must determine whether the recorded historical proof satisfies the unchanged original clause; this handover does not assert completion.

### 9. P2: zero contribution undefined when the model was not exercised

Proposed disposition: preserve implemented distinction, leave actual contribution/removal decisions unmeasured. At e418, eval/ablation-experiment.ts:90 counts only successful settled uncached calls, and verdict-step Spark for reasoning; :292 avoids paying for an arm absent from baseline invocation coverage; :347 rejects an allegedly removed model that still executes. Transport test:437 asserts no arm upload and not-measured output for unexercised models.

Remaining proof: actual baseline invocation coverage plus complete same-population/deployment results before any zero-contribution classification. Publication must retain not-measured for unexercised/missing/incomparable data rather than fabricate zero deltas. If qualifying unchanged outcomes are measured, file a named removal/rework section through the authorized workflow and link it. No such measured finding or new section is asserted here; removal is not authorized by an empty model-use list.

## Activation and acceptance boundary

The current corrected contract already retains all nine obligations; its wording is not changed by this package. The existing stamped section 17 replay mechanism satisfies the original either-replay-or-wait design path at source level, but actual fresh-arm and resume acceptance still needs measured proof. Do not restore the old 24-hour scheduling fallback or rebuild the runner. The section's existing checked historical impersonation item is not promoted into current deployment evidence: preserve its stated denominator and coverage limits and verify acceptance against the original finding.

Activation is separate from completion: root first audits this document and exact source package, installs the committed authorization pin entry through the owning workflow, and releases the existing detection-eval owner for the remaining metrics/publication work. Implementation and targeted no-spend tests must preserve the exact normalized authorized contract. One supported Codex combined completion may run only on its final descendant after every original obligation is satisfied; add --transition-plan and preserve the original Muse report. Pending monitor/deployment/live evidence is a blocker, never permission to request an invented complete verdict. Returned gaps use only the existing bounded reconciliation route.

No serving deployment, authenticated API/database read, new population, model invocation, cap change, spend or publication occurred while preparing this package. The original readiness 63-test result and coordinator-reported 89-test runner integration result remain attributed prior evidence, not newly executed tests. All original review history, interrupted manifests and accounting must survive installation.
