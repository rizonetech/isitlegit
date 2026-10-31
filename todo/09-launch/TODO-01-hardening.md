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
| 4 | §4 | Counterparty limits verified live | §1, D05 T02 §1 | [ ] |

## 1. Limits and retention verified live

> **Started:** 2026-10-31T10:58Z

Upload and attachment size limits, per-organisation daily caps, counterparty limits, sign-in rate limits and the R2 lifecycle rule are each exercised against the deployed service with synthetic inputs, and the results recorded.

**Corrected 2026-10-31** (plan fact-check against the tree and the coordinator; the `Started:` line was first written at 10:45Z, before this check, in `63ee9d6b`, and is re-recorded here so the plan review reads the contract as it will be built):
- The script is `eval/launch/check-limits.ts`, not `scripts/check-limits.ts`: `scripts/` is shared tooling the eval lane does not write (`AGENTS.md`, Parallel lanes). The lane never touches production: it builds the script and its stub tests, and the coordinator runs it live once the operator approves (coordinator, 2026-10-31 09:24 UTC). The checkpoint was a live run only; it is now the stub tests plus that live run.
- Counterparty limits are not built: they are D05 T02 §1 (the trust lane's, open). Their live check moves to D09 T01 §4, which depends on it.
- No route or script sets `org_limits.daily_cases` (`scripts/org-plan.ts` sets the plan only), so the cap check sets it by SQL on the test organisation and restores it. It sets the cap to today's case count plus one, so one small upload is admitted and the next refused: one analysis paid for, not three (a cap of exactly 3 would admit three when the organisation has none today, and admit none when it already has three).
- The upload route takes a Better Auth session cookie only (`requireSession`, `requireOrg`, `src/intake/upload.ts:33`); the script reads one signed-in test member's cookie from the environment (`ISITLEGIT_SESSION`), never from its arguments or a file, and never prints it.
- The size checks send only refused bodies (25 MiB and a byte, with and without a declared length): an admitted 25 MiB file would store, analyse and pay for a case. The boundary just under the limit is the unit tests' (`test/intake/upload.test.ts`).
- The sign-in rate limit is exercised on `POST /signin/confirm` (the scanner-safe page's button, which redeems through Better Auth's `/magic-link/verify` server-side and is counted per IP in D1, 20 per 10 minutes, `src/auth/ratelimit.ts`, `src/auth/confirm.tsx`; a `GET /api/auth/magic-link/verify` only redirects to that page) with tokens that are not ones and the app's own `Origin` (the route refuses another with 403): it sends no mail, where `/sign-in/magic-link` and `/signin/code` would mail the member twenty times. It locks the running IP out of link verification for 10 minutes, which the run says before it starts.
- The mail limit is Email Routing's 25 MiB and the Worker's `MAX_MESSAGE_BYTES` (`src/intake/email.ts:21`), which rejects with "Message too large" before any sender lookup, so no case and no notice exist to read back; the check sends one oversized synthetic message through SMTP2GO's API from `alerts@isitlegit.co.za` to `check@isitlegit.co.za` and reads SMTP2GO's delivery record for that message (rejected or bounced passes; delivered or a case for its Message-ID fails).
- The R2 rule exists only as the bucket's configuration (`raw-30-days`, applied by Wrangler in D00 T01 §5); the check reads it back with `wrangler r2 bucket lifecycle list isitlegit-artefacts` and compares it exactly. Back-dating an object is not possible in R2, so "verify the rule configuration exactly" is the path taken.

**Phase:** 6
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Write the limits script with every production effect injected, test it against stubs, and hand the coordinator its exact command. Done when: the stub tests pass, and the coordinator's live run prints one `ok` line per limit and `docs/live-checks.md` records each limit's observed behaviour.

- [ ] Write `eval/launch/check-limits.ts` with `parseLimitsArgs(argv)`: `--confirm-production` required to send anything, `--base-url` (default `https://app.isitlegit.co.za`), `--org <id>` (the test organisation), `--only <check,...>`; strict, an unknown argument refused before any secret is read. Done when: the test refuses a run without `--confirm-production`, an unknown option and a stray argument.
- [ ] Write `uploadSize(deps)`: a 25 MiB + 1 byte multipart upload to `POST /api/upload`, once with `Content-Length` and once streamed without one, each must answer 413 with the upload route's message, and the test organisation's case count must not change. Done when: stubs answering 413 pass, and a stub answering 201, a 413 with another message, or a case count that moved each fail naming why.
- [ ] Write `dailyCap(deps)`: read the organisation's `org_limits.daily_cases` (null when no row) and today's case count (since 00:00 SAST, as `src/db/cases.ts` counts), set the cap to that count plus one, upload one small synthetic `.eml` (expect 201), upload a second (expect 429 with the cap message), then restore the cap exactly (the old value, or the row's absence) in a `finally`. Done when: the test passes on stubs, fails on a second upload that is admitted, and restores the cap on every path (a 500 on the first upload, a thrown read) with the SQL it ran recorded.
- [ ] Write `signInRate(deps)`: 20 POSTs to `/signin/confirm` with random non-tokens and the app's `Origin`, each answering 400 (the new-link page), then a 21st answering 429. Done when: the test passes on a stub limiter and fails when the 21st is not 429, an earlier one is, or one answers 403 (a wrong `Origin`).
- [ ] Write `mailSize(deps)`: one synthetic message just over 25 MiB (a generated attachment of random bytes, no real content) sent through SMTP2GO's API with the key from the environment (`SMTP2GO_API_KEY`), then SMTP2GO's record for that message read until it is final (bounded wait); rejected or bounced passes, delivered fails, and no case may exist for its Message-ID. Done when: the test passes on a stub bounce and fails on a stub delivery or a case.
- [ ] Write `r2Lifecycle(deps)`: the rules `wrangler r2 bucket lifecycle list isitlegit-artefacts` prints, parsed; pass only when `raw-30-days` is enabled with prefix `raw/` and 30 days. Done when: the test passes on that output and fails on a missing rule, a disabled one, another prefix or another age.
- [ ] Print one line per check (`ok`, `FAIL <why>` or `skipped <why>`) and exit 0 only when every check run is `ok`; never print a cookie, key or token. Done when: the test reads the output of a mixed run, its exit code, and no secret value in it.
- [ ] Test every production effect through injected `fetch`, D1 executor, Wrangler runner and SMTP2GO client in `test/node/check-limits.test.ts`. Done when: the file passes under `taskset -c 0,1` and no test reaches the network.
- [ ] Hand the coordinator the exact live command, what it creates (one admitted case named `limits-check-<run>`, one oversized message, the cap set and restored, a 10-minute verify lockout for the running IP) and how it cleans up. Done when: the message is sent and recorded in the run file.
- [ ] Record each limit's observed behaviour from the coordinator's live run in `docs/live-checks.md` (run time, deployed commit, each check's line, the case and message ids). Done when: the entry exists with every check `ok`, or a failing check is filed through `add-todo` at its owner.
- [ ] Commit: `launch: limits and retention verified on the deployment`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/check-limits.test.ts` passes (and fails when an admitted oversized upload, an admitted capped upload, a 21st verify that is not 429, a delivered oversized mail or a changed R2 rule is reported `ok`), and the coordinator's `node eval/launch/check-limits.ts --confirm-production --org <test org>` exits 0 printing `ok` for `upload-size`, `daily-cap`, `sign-in-rate`, `mail-size` and `r2-lifecycle`.

> **Deferred:** counterparty limits verified live -> XREF: D09 T01 §4

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

## 4. Counterparty limits verified live

The counterparty check's rate limits (per sender and per protected business, `AGENTS.md` safety contract) exercised against the deployed service with synthetic inputs, once D05 T02 §1 has built them; split from §1, where they were not yet built (2026-10-31).

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Add a counterparty check to `eval/launch/check-limits.ts` and run it live through the coordinator. Done when: `docs/live-checks.md` records each counterparty limit's observed behaviour.

- [ ] Read D05 T02 §1's shipped limits (route, window, maximum, response) from its code and receipt. Done when: each limit is named with `file:line`.
- [ ] Write `counterpartyRate(deps)` in `eval/launch/check-limits.ts`: requests up to each limit on a synthetic sender and a synthetic protected business, the next one refused, never revealing a registered bank detail. Done when: `test/node/check-limits.test.ts` passes on stubs and fails when the request past a limit is admitted.
- [ ] Hand the coordinator the live command and record the result in `docs/live-checks.md`. Done when: the entry exists with the check `ok`.
- [ ] Commit: `launch: counterparty limits verified on the deployment`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/check-limits.test.ts` passes and fails when a counterparty request past its limit is reported `ok`.

## Verification

- Limits, retention and every failure mode behave as specified on the deployment, and the full review ends with no P1 or P2.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
