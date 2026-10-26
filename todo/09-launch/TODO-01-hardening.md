---
schema_version: 1
id: hardening
domain: 09-launch
status: active
title: "TODO-01 -- Production Hardening and the Full Review"
track: day-6
---

# TODO-01 -- Production Hardening and the Full Review

> **Goal:** The live service holds up under real use (Startup track lens): size limits and per-organisation rate limits on every entry point, retention verified, every external failure (Meta API down, budget spent, Browser Run timeout, oversized mail, provider outage) produces a clearly marked partial report, and a full-diff independent review across all lenses finds no open P1 or P2.

> **Current state:** Measured 2026-10-26 20:00 SAST. Individual limits and failure paths are built in their own sections; this file proves them together on the deployed service.

## Inputs

- Design spec 3 (Startup lens: holds up in production), 4.8 (retention), 8 (risks), 11 (decisions); `docs/manifesto.md` (Reliability: no silent failure); `docs/hackathon-criteria.md`.

## Outcome

- A failure-injection run on the deployment shows each failure mode ending in a partial report with the right text and no stuck case.
- The full-diff review's last round has no P1 or P2.

**Adjacency:** all=not-applicable (cross-cutting verification of behaviour owned by other files)

**Adjacency rationale:** This file tests and reviews what other files built.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Limits and retention verified live | D07 T02 §4, D01 T03 §1 | [ ] |
| 2 | §2 | Failure injection on every dependency | §1, D04 T01 §4 | [ ] |
| 3 | §3 | Full-diff independent review | §2 | [ ] |

## 1. Limits and retention verified live

Upload and attachment size limits, per-organisation daily caps, counterparty limits, sign-in rate limits and the R2 lifecycle rule are each exercised against the deployed service with synthetic inputs, and the results recorded.

**Phase:** 6
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Run a limits script against production. Done when: `docs/live-checks.md` records each limit's observed behaviour.

- [ ] Write `scripts/check-limits.ts` exercising the 25 MiB upload limit, the 25 MiB mail limit, the daily case cap (on a test organisation with cap 3), counterparty limits and sign-in rate limits. Done when: each check passes against production.
- [ ] Read back the R2 lifecycle rule and confirm an object older than 30 days under `raw/` in a test prefix is gone (place one with a back-dated test rule or verify the rule configuration exactly). Done when: the result is recorded.
- [ ] Commit: `launch: limits and retention verified on the deployment`

**Test checkpoint:** `pnpm exec tsx scripts/check-limits.ts` exits 0 printing one line per limit with `ok`.

## 2. Failure injection on every dependency

For each external dependency a test hook (enabled only for a test organisation) forces the failure in production, and the case must end `partial` with the right notice and a reply that says what happened (manifesto Reliability).

**Phase:** 6
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Add test-organisation failure hooks. Done when: each hook forces exactly its failure.
2. Run them live. Done when: each case is `partial` with the right notice.

- [ ] Add failure hooks for Meta API error, budget refusal, Browser Run timeout, Web Risk outage, RDAP outage and SMTP2GO 5xx, enabled only for organisations flagged `test`. Done when: `test/launch/hooks.test.ts` proves a normal organisation cannot enable them.
- [ ] Run each hook live with a synthetic fixture and record status, notice text and reply in `docs/live-checks.md`. Done when: six entries show `partial` and no case remains `running` after 10 minutes.
- [ ] Commit: `launch: failure injection on every external dependency`

**Test checkpoint:** `pnpm exec tsx scripts/failure-drill.ts` exits 0 after all six cases end `partial`.

## 3. Full-diff independent review

The whole product diff since the first commit is reviewed by the pinned reviewer across every lens (adversarial, integration, source-defect, plan-delivery, consistency, quality, design, optimization, record), and every P1 and P2 is fixed at its owning layer before submission (plan Day 8).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Run the full review. Done when: `docs/reviews/09-launch/full-diff.md` holds the rounds.
2. Fix and re-review until a round has no P1 or P2. Done when: the last round says so.

- [ ] Write the review prompt from `docs/review-round-prompt.md` with the range `f6d4088..HEAD` and run `scripts/review-dispatch.py` recording to `docs/reviews/09-launch/full-diff.md`. Done when: round 1 is recorded.
- [ ] Fix each P1 and P2 in its own commit with a regression test, and file P3s through `add-todo`. Done when: each finding names a commit or a filed section.
- [ ] Repeat until a round returns no P1 or P2. Done when: that round is recorded.
- [ ] Commit: `launch: full-diff review findings fixed`

**Test checkpoint:** `grep -cE '^HIGHEST: (P3|none)$' docs/reviews/09-launch/full-diff.md` prints at least `1`.

## Verification

- Limits, retention and every failure mode behave as specified on the deployment, and the full review ends with no P1 or P2.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
