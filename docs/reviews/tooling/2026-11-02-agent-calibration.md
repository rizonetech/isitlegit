# Agent verdict calibration (coordinator, no TODO section)

## Writer note: candidate

- Range: 0fbcc49b..9c63784e3c5b630897873dd9ad2e00a911abbf72 (0d2967e1 calibration v1, 9c63784e calibration v2).
- Writer: claude (coordinator on main); reviews run with --writer claude.
- Why no section: emergency calibration after the coordinator probe showed the published 0.111 was invalid and the agent-running deployment measured detection 0.600 with false positives 18/70, every sampled false positive citing incomplete checks. Recorded in todo/findings.md (2026-11-02 entries).
- State at review: already pushed to main and deployed (Worker 78124330, /health commit 9c63784e) before this review ran; findings are fixed forward, never by rewriting the pushed commits.
- Evidence so far: test/agent/loop.test.ts 12 passed; gate 41446373115 green; v2 after-figures wait on the eval org day-cap reset (500/day exhausted by measurement), re-probe planned on the full 160.

## Round 1: astra (`gpt-6-astra` via `codex`)

- Writer: claude
- Run: 2026-11-02T12:49:51Z
- Effort: medium
- Lenses: adversarial, integration, source-defect, plan-delivery
- Pin: ce29c18a398871b473c634630dbf588c04ec5ef2
- Lines: 20
- Digest: 684f2d2d1cb8c53f

### adversarial: approve

No new adversarial finding in this candidate.

### integration: needs-attention

1. **P1** · [src/agent/loop.ts:70](../../../src/agent/loop.ts#L70): The rule explicitly classifies an ordinary payment request as suspicious. “The evidence ties to harm” qualifies only the link/domain alternative; payment and bank-detail requests need no harmful context. Reproduce through the upload/email → analysis workflow → `runAgent` path with a genuine invoice asking for payment to the unchanged account on file. Following this instruction produces `suspicious` solely because payment was requested. The floor cannot lower that result, and citation validation checks IDs, not whether they justify suspicion. Require evidence of deception or harm for these asks, preserving legitimate invoice controls. This is a reachable prompt-policy defect; its live frequency was not measured in this review.

### source-defect: approve

No additional candidate-specific finding against the governing safety contract.

### plan-delivery: needs-attention

2. **P3** · [test/agent/loop.test.ts:180](../../../test/agent/loop.test.ts#L180): The regression test does not protect the substantive correction from v1. Delete the entire sentence beginning “A message that asks”, leaving “Judge the ask itself” and the missing-evidence sentence: both assertions still pass. Aggregating all requests also does not require the calibration in the final verdict request’s developer instructions. Assert the substantive rule in the parsed developer messages of the investigation and finalisation requests. Complete removal or an exact v1 rollback would fail, but losing the intended distinction would not.

No TODO checklist applies. The recorded re-probe remains pending, so effectiveness of the final calibration is unverified. Review was static; no files changed and no tests or live model calls ran.

HIGHEST: P1
OVERALL: needs-attention

- Implemented (round 1 P1): the rule no longer classifies an ordinary payment request as suspicious. Suspicion on content now requires handing over sign-in details, signing in through a supplied link or page, paying into new or changed bank details, or following a link or domain the evidence ties to harm. A routine ask the evidence does not tie to harm, such as a payment to the bank details already on file, is expressly protected alongside the missing-evidence clause.
- Implemented (round 1 P3): the regression test now asserts the substantive phrases in every request body the agent sends, not only the headline in the aggregate. Proven to fail on the v2 wording (1 failed, 11 skipped) and pass on v3 (12 passed).
