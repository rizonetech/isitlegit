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
| 5 | §5 | Mail-sending limits verified live | §1 | [ ] |

## 1. Limits and retention verified live

> **Started:** 2026-10-31T10:58Z

Upload and attachment size limits, per-organisation daily caps, counterparty limits, sign-in rate limits and the R2 lifecycle rule are each exercised against the deployed service with synthetic inputs, and the results recorded.

**Corrected 2026-10-31** (plan fact-check against the tree and the coordinator; the `Started:` line was first written at 10:45Z, before this check, in `63ee9d6b`, and is re-recorded here so the plan review reads the contract as it will be built):
- The script is `eval/launch/check-limits.ts`, not `scripts/check-limits.ts`: `scripts/` is shared tooling the eval lane does not write (`AGENTS.md`, Parallel lanes). The lane never touches production: it builds the script and its stub tests, and the coordinator runs it live once the operator approves (coordinator, 2026-10-31 09:24 UTC). The checkpoint was a live run only; it is now the stub tests plus that live run.
- Counterparty limits are not built: they are D05 T02 §1 (the trust lane's, open). Their live check moves to D09 T01 §4, which depends on it.
- No route or script sets `org_limits.daily_cases` (`scripts/org-plan.ts` sets the plan only), so the cap check sets it by SQL on the test organisation and restores it. It sets the cap to today's case count plus one, so one small upload is admitted and the next refused: one analysis paid for, not three (a cap of exactly 3 would admit three when the organisation has none today, and admit none when it already has three).
- The upload route takes a Better Auth session cookie only (`requireSession`, `requireOrg`, `src/intake/upload.ts:44`, corrected 2026-11-02 from line 33); the script reads one signed-in test member's cookie from the environment (`ISITLEGIT_SESSION`), never from its arguments or a file, and never prints it.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** (1) The cap text here says `org_limits.daily_cases`; the shipped script sets `daily_cases_override`, the column admission reads (`eval/launch/check-limits.ts:323`, `src/auth/plan-sql.ts:42`), so the script is right and this text is stale wherever it names the column. (2) The test count in the closeout item below reads 35; `test/node/check-limits.test.ts` now runs 44, all passing (re-run 2026-11-02, `taskset -c 3 pnpm exec vitest run test/node/check-limits.test.ts`). (3) `taskset -c 0,1` in checkpoints is the eval lane's pin; this lane runs on core 3.
- The size checks send only refused bodies (25 MiB and a byte, with and without a declared length): an admitted 25 MiB file would store, analyse and pay for a case. The boundary just under the limit is the unit tests' (`test/intake/upload.test.ts`).
- The sign-in rate limit is exercised on `POST /signin/confirm` (the scanner-safe page's button, which redeems through Better Auth's `/magic-link/verify` server-side and is counted per IP in D1, 20 per 10 minutes, `src/auth/ratelimit.ts`, `src/auth/confirm.tsx`; a `GET /api/auth/magic-link/verify` only redirects to that page) with tokens that are not ones and the app's own `Origin` (the route refuses another with 403): it sends no mail, where `/sign-in/magic-link` mails a link each time. It locks the running IP out of link verification for 10 minutes, which the run says before it starts.
- The mail limit is Email Routing's 25 MiB and the Worker's `MAX_MESSAGE_BYTES` (`src/intake/email.ts:21`), which rejects with "Message too large" before any sender lookup, so no case and no notice exist to read back; the check sends one oversized synthetic message through SMTP2GO's API from `alerts@isitlegit.co.za` to `check@isitlegit.co.za` and reads SMTP2GO's delivery record for that message (rejected or bounced passes; delivered or a case for its Message-ID fails).
- The R2 rule exists only as the bucket's configuration (`raw-30-days`, applied by Wrangler in D00 T01 §5); the check reads it back with `wrangler r2 bucket lifecycle list isitlegit-artefacts` and compares it exactly. Back-dating an object is not possible in R2, so "verify the rule configuration exactly" is the path taken.

**Corrected 2026-10-31** (plan review, 2 P1 and 4 P2, `docs/reviews/09-launch/D09-T01-s1.md`): the mail check passes only on a rejection attributable to size, never on any bounce; a preflight proves the session's active organisation is the approved test organisation before anything is changed or sent; the cap check's two uploads are distinct per run and their cases are read back; the cap's restoration is read back, other `org_limits` columns kept, and a failed restoration exits nonzero with the exact recovery SQL; the sign-in checks start on a fresh window (run the bucket out, wait the window it reports) and confirm requests resume after it; code entry (`/signin/code`, which verifies a code and mails nothing) and passkey options join link verification, each its own per-IP bucket; the email cap's notice and the link-request limit (both mail the member) move to D09 T01 §5.

**Phase:** 6
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Write the limits script with every production effect injected, test it against stubs, and hand the coordinator its exact command. Done when: the stub tests pass, and the coordinator's live run prints one `ok` line per limit and `docs/live-checks.md` records each limit's observed behaviour.

- [x] Write `eval/launch/check-limits.ts` with `parseLimitsArgs(argv)`: `--confirm-production` required to send anything, `--base-url` (default `https://app.isitlegit.co.za`), `--org <id>` (the test organisation), `--only <check,...>`; strict, an unknown argument refused before any secret is read. Done when: the test refuses a run without `--confirm-production`, an unknown option and a stray argument. Done 2026-10-31.
- [x] Write `preflight(deps)`: read the session (`GET /api/auth/get-session` with `ISITLEGIT_SESSION`) and refuse, before any write, upload or mail, unless it is signed in and its `activeOrganizationId` equals `--org`, and that organisation's row exists in the live D1. Done when: the test finds a signed-out session, another active organisation and an unknown `--org` each stop the run with no upload, no SQL write and no mail. Done 2026-10-31.
- [x] Write `uploadSize(deps)`: a 25 MiB + 1 byte multipart upload to `POST /api/upload`, once with `Content-Length` and once streamed without one, each must answer 413 with the upload route's message, and the test organisation's case count must not change. Done when: stubs answering 413 pass, and a stub answering 201, a 413 with another message, or a case count that moved each fail naming why. Done 2026-10-31.
- [x] Write `dailyCap(deps)`: read the organisation's whole `org_limits` row (or its absence) and today's case count (since 00:00 SAST, as `src/db/cases.ts` counts); set only `daily_cases` to that count plus one (an `UPDATE` of that column, or an `INSERT` of a new row when there was none); upload two small synthetic `.eml` files made for this run (distinct bytes and names carrying the run id, so intake's repeat detection never answers them); expect 201 for the first, its case in this organisation and the count up by exactly one, and 429 with the cap message for the second with no new case. Done when: the test passes on stubs and fails on a second upload that is admitted, a 200 repeat, a first case in another organisation or a count that moved by other than one. Done 2026-10-31: `dailyCap` and `capAttempt`.
- [x] Restore the cap in a `finally`: `daily_cases` back to its old value with the row's other columns untouched, or the row deleted when the run inserted it; read it back and compare with the row as first read; on a failed or wrong restoration exit nonzero and print the exact SQL that restores it. Done when: the test restores on every path (a 500 on the first upload, a thrown read) and finds a failed `UPDATE` and an `UPDATE` whose read-back is wrong each exit nonzero naming the recovery SQL. Done 2026-10-31: restored after the attempt on every path (not a `return` inside `finally`), read back and compared whole.
- [x] Write `signInRate(deps, path)` for each per-IP bucket that mails nothing: `/signin/confirm` (a random non-token), `/signin/code` (a wrong code) and `/api/auth/passkey/generate-authenticate-options`, each request shaped as its route takes it with the app's `Origin`. Start on a fresh window: send until the first 429, wait the window it reports (or the full 600 s when it reports none, bounded at 11 minutes), then send 20 that are not 429 and a 21st that is; then wait out that window and send one more, which must not be 429. Done when: the test passes on a stub limiter, passes on one whose bucket was already part used, and fails when the 21st is not 429, an earlier one is, one answers 403 (a wrong `Origin`), or the request after the window is still 429. Done 2026-10-31: `rateLimit(deps, target)` over `RATE_TARGETS`; passkey options is a `GET` (Better Auth's endpoint), the other two `POST` forms.
- [x] Write `mailSize(deps)`: one synthetic message just over 25 MiB (a generated attachment of random bytes, no real content) sent through SMTP2GO's API with the key from the environment (`SMTP2GO_API_KEY`) to `check@isitlegit.co.za`, then SMTP2GO's record for that message read until it is final (bounded at 10 minutes). It passes only on a rejection whose reason names the size (the Worker's "Message too large", or an SMTP 552 / 5.3.4 size refusal from Cloudflare). **Corrected 2026-10-31** (build): "no case for its Message-ID" is dropped: SMTP2GO sets the Message-ID, and the sender `alerts@isitlegit.co.za` is no member, so no case could follow the message whatever its size; the size-attributed rejection is the proof. Done when: the test passes on a stub size rejection and fails on a delivery, a rejection for another reason (an unknown recipient, a sender refusal, a provider error) and a record that never becomes final. Done 2026-10-31.
- [x] Write `r2Lifecycle(deps)`: the rules `wrangler r2 bucket lifecycle list isitlegit-artefacts` prints, parsed; pass only when `raw-30-days` is enabled with prefix `raw/` and 30 days. Done when: the test passes on that output and fails on a missing rule, a disabled one, another prefix or another age. Done 2026-10-31: `rawRule` reads a `key: value` block or a table row and fails closed on anything else; the first live run confirms Wrangler's format.
- [x] Print one line per check (`ok`, `FAIL <why>` or `skipped <why>`) and exit 0 only when every check run is `ok`; never print a cookie, key or token. Done when: the test reads the output of a mixed run, its exit code, and no secret value in it. Done 2026-10-31: `runChecks`, `line`.
- [x] Test every production effect through injected `fetch`, D1 executor, Wrangler runner and SMTP2GO client in `test/node/check-limits.test.ts`. Done when: the file passes under `taskset -c 0,1` and no test reaches the network. Done 2026-10-31: 27 tests; seven mutations (preflight, restore read-back, 21st request, any bounce, rule age, admitted capped upload, admitted oversized upload) each caught. `sastDayStart` is restated in the script (`src/db/cases.ts` does not load under plain Node) and tested equal to it.
- [x] Close the completion review's gaps (2026-10-31, `docs/reviews/09-launch/D09-T01-s1.md`): the cap check writes its recovery record (`fileStore`, `~/isitlegit-data/launch/limits-recovery.json`) before it changes anything and refuses when it cannot, a run restores what an earlier run left before anything else (`recoverPending`) and on Ctrl+C or SIGTERM; SMTP2GO is searched by `search_email_id` and only `delivered`, `hard-bounced` and `rejected` are final; a bare 552 no longer counts as a size rejection; only an expiration after 30 days satisfies the R2 rule (a transition or a multipart abort does not); a bucket must answer as its route does after the window, not merely not 429; every request is bounded (`timed`, 120 s) and every answer read only to 64 KiB (`bodyText`); each check's evidence (ids, statuses, the cap's restoration) goes into a secret-free run record printed last and kept in the launch folder; the three sign-in buckets wait together (about 21 minutes, not an hour), with a line at least once a minute. Done when: `test/node/check-limits.test.ts` covers each (35 tests and the Worker project's `test/launch/sast-day.test.ts`; a mutation per gap caught). Done 2026-10-31.
- [x] Hand the coordinator the exact live command, what it creates (one admitted case named `limits-check-<run>`, one oversized message, the cap set and restored, a 10-minute verify lockout for the running IP) and how it cleans up. Done when: the message is sent and recorded in the run file. Done 2026-10-31: sent with the run at `56449a15` (rounds 1 to 3 fixed, round 4 clean): the command, its environment, every production effect (one admitted case, the cap set and restored with its recovery record, the three buckets locked about 21 minutes, one oversized message) and the run record to send back.
- [ ] Record each limit's observed behaviour from the coordinator's live run in `docs/live-checks.md` (run time, deployed commit, each check's line, the case and message ids). Done when: the entry exists with every check `ok`, or a failing check is filed through `add-todo` at its owner.
- [ ] Commit: `launch: limits and retention verified on the deployment`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/check-limits.test.ts` passes (and fails when an admitted oversized upload, an admitted capped upload, a cap left unrestored, a 21st request that is not 429, a bounce for another reason or a changed R2 rule is reported `ok`, or a session in another organisation gets past the preflight), and the coordinator's `node eval/launch/check-limits.ts --confirm-production --org <test org>` exits 0 printing `ok` for `upload-size`, `daily-cap`, `sign-in-confirm-rate`, `sign-in-code-rate`, `passkey-options-rate`, `mail-size` and `r2-lifecycle`.

> **Deferred:** counterparty limits verified live -> XREF: D09 T01 §4
> **Deferred:** the email cap's notice and the sign-in link-request limit verified live (both mail the member) -> XREF: D09 T01 §5

## 2. Failure injection on every dependency

For each external dependency a test hook (enabled only for a test organisation) forces the failure in production, and the case must end `partial` with the right notice and a reply that says what happened (manifesto Reliability).

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** (1) The checkpoint cannot run: `tsx` is not a dependency anywhere in this tree (the pattern is plain `node`, as in `node eval/run.ts`), and `scripts/failure-drill.ts` does not exist; by §1's own correction (line 46, `scripts/` is shared tooling this lane does not write) the drill's home is `eval/launch/`, not `scripts/`. (2) "Organisations flagged `test`" names no existing flag or hook in `src/`; the build's first item must name the hook mechanism (where each of the six hooks lives, how Browser Run timeout and RDAP/Web Risk outages are forced distinctly, and the exact notice text per failure) before "each hook forces exactly its failure" is falsifiable. (3) The checkpoint must assert the six `partial` outcomes, not only the drill's exit 0. Shipped machinery it relies on: a failed step ends a case `partial` with the step named (`src/pipeline/analysis-workflow.ts:500`).

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

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** D05 T02 §1 is stamped and the limits exist (5 per sender per day, 50 per protected identity per day, `src/db/cases.ts:62`), so this section is unblocked. Drift: `counterpartyRate` does not exist in `eval/launch/check-limits.ts` yet, and the observable cannot be an HTTP refusal: past the limit the mail path drops silently with no notice (`src/intake/email.ts:170`), so the item's Done when must name the D1 case count for the protected organisation as the observable.

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

## 5. Mail-sending limits verified live

The two limits whose live check mails a member, split from §1 (plan review, 2026-10-31): the email path's daily cap (a forward past the cap gets one notice per forwarder per SAST day, `sendCapNotice` in `src/intake/email.ts`, and no case) and the sign-in link-request limit (`/api/auth/sign-in/magic-link`, 20 per 10 minutes per IP, `src/auth/ratelimit.ts`).

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** neither `emailCap` nor `linkRequestRate` exists in `eval/launch/check-limits.ts`; the shipped near-names are `dailyCap`/`capAttempt` and `rateLimit` over `RATE_TARGETS`, which the new items should name and reuse. The `emailCap` stub test also needs an injected inbox reader in the deps shape (notice counting reads the member's inbox), which `test/node/check-limits.test.ts` does not have yet; name it in the item before the test is written. Verified: `sendCapNotice` at `src/intake/email.ts:208`, its subject at line 230, the 20 per 600 s limit at `src/auth/ratelimit.ts:11`.

**Phase:** 6
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Add both checks to `eval/launch/check-limits.ts` and run them live through the coordinator. Done when: `docs/live-checks.md` records each one's observed behaviour.

- [ ] Write `emailCap(deps)`: with the test organisation's cap at today's count (set and restored as §1's `dailyCap` does), one synthetic forward from the test member to `check@isitlegit.co.za` through SMTP2GO; no case for its Message-ID, and exactly one notice "Today's IsItLegit checks are used up" in the member's inbox (read through the Microsoft 365 connector, narrow and read-only, `AGENTS.md`); a second forward the same day sends no second notice. Done when: `test/node/check-limits.test.ts` passes on stubs and fails on a created case, a missing notice or a second notice.
- [ ] Write `linkRequestRate(deps)`: 20 link requests for the test member's address from one IP, none refused, a 21st refused, on a fresh window as §1 starts one; the member's inbox is read only to count the links that arrived. Done when: the test passes on a stub limiter and fails when the 21st is admitted.
- [ ] Hand the coordinator the live command (what it mails, to whom, and how many) and record the result in `docs/live-checks.md`. Done when: the entry exists with both checks `ok`.
- [ ] Commit: `launch: mail-sending limits verified on the deployment`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/check-limits.test.ts` passes and fails when a capped forward creates a case or a 21st link request is admitted.

## Verification

- Limits, retention and every failure mode behave as specified on the deployment, and the full review ends with no P1 or P2.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
