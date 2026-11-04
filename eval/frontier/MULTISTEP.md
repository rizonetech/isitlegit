# Wonder multi-step experiment

D08 T03 §3 measures five contained Wonder walks through a synthetic cookie banner, human checkbox and document lure. The harness uses the existing driver with its unchanged eight-step and sixty-second limits. Reaching the credential page is different from submitting the canary-only form. Offline browser tests prove fixture behavior, not model success. The 2026-11-04 bounded run returned five pre-model errors, zero credential arrivals and zero model calls. Its exact state is in `multistep-results-2026-11-04.json`; model navigation capability remains unmeasured.

## Release prerequisites

Checks owns the binding in `src/fixtures/redirects.ts`: serve the four HTML files under the existing secret fixture prefix at `nimbusmail-multistep/`, `nimbusmail-multistep/lure`, `nimbusmail-multistep/login` and `nimbusmail-multistep/submitted`. Normalize the index slash as existing fixture routes do. Preserve the fixtures host restriction, secret prefix, `X-Robots-Tag: noindex` and `Cache-Control: no-store`. Each page is standalone and has no external assets; the login form discards values before navigating and never sends them. The coordinator owns CI and deployment.

Before a paid attempt, obtain the exact released commit and shared spending headroom. The harness requires a clean committed checkout, checks local product source against that deployed commit, verifies the app health commit and fetches all four pages with bounded bodies and redirects refused. Every page must match its local SHA-256 and required headers. A missing route, changed body, wrong deployment or exhausted budget blocks execution. Do not substitute local fixtures for deployed preflight.

## Commands

Use Node and pnpm versions required by the repository and installed dependencies. Read `node eval/frontier/multistep.ts --help` without credentials. Supply `MULTISTEP_URL` through authorized environment handling; never put the secret-prefix URL in argv, public logs or reports. The existing protected vault reader supplies provider credentials only after the whole-walk reservation has been verified. Do not print those values.

```bash
node eval/frontier/multistep.ts run --confirm-credit --deployed-sha FULL_DEPLOYED_COMMIT
node eval/frontier/multistep.ts reconcile
node eval/frontier/multistep.ts score
node eval/frontier/multistep.ts score --check docs/frontier-log.md
```

Replace `FULL_DEPLOYED_COMMIT` with the verified forty-character commit. The default private experiment directory is `~/isitlegit-data/frontier/multistep`; `--dir` selects a specific authorized experiment. Keep the same directory on resume. Never choose a fresh directory to evade accounting or replace an unknown ordinal. A run has five fixed ordinal identities. A definitively unstarted shared-budget refusal retains its zero-cost ledger identity in history and may later retry that same ordinal under a new reservation. An attempted or unknown walk is never resent.

The initial local allowance is US$5, with the shared ledger enforcing its own caps. An authorized staged increase uses `--cap-usd 10 --decision 'dated reason based on measured usage and useful remaining attempts'`, then US$20 only after US$10. The harness requires positive measured usage, remaining ordinals and a recorded reason. It preserves prior charges and decisions; it never changes shared spending settings. Escalate a shared-cap refusal to the coordinator. Reversal cancels unspent attempts; incurred charges remain counted.

## Interruptions and capacity

State is validated, written to a private temporary file, fsynced and renamed with directory fsync. A kernel lock excludes overlapping parent commands; a separate child lock prevents reconciliation while a paid child survives a killed parent. These are local process/write proofs, not a claim that arbitrary hardware failure cannot lose filesystem data.

A pending or observed ordinal blocks `run` until `reconcile` validates its saved child report and exact shared-ledger reservation. Reconciliation makes no provider call. It settles a durable observation idempotently and verifies read-back. A missing child report with a matching still-counted reservation becomes unknown with its full allowance retained. A missing or mismatched reservation or conflicting settlement stays blocked for coordinator resolution. Do not hand-edit state, erase child reports, remove a live lock, release an uncertain charge or infer navigation from a ledger row.

Provider capacity responses retain bounded Retry-After metadata without changing the response. Transport attempts are fixed at one. The next remaining ordinal waits until the persisted deadline: two, five, ten, twenty, thirty, sixty and 120 minutes, then doubling, plus positive jitter and any longer provider minimum. The command exits after a capacity failure; it does not sleep and retry automatically. Never reset state to shorten the wait.

`score` recomputes numerator, denominator, credential-arrival step/time, final step/time and measured versus estimated cost from strict observations. Arrival is bound by screenshot key to the driver's durable action row, whose ordered action index and timestamp are retained. A later submission timeout or ninth action does not erase a qualifying earlier arrival; an arrival without matching evidence is not scored successful. Unknown attempts remain in the denominator as unsuccessful and explicitly incomplete. `score --check` refuses unknown outcomes or a log that differs from the computed entry. Publish the entry only after all five observations are accounted for. Fewer than four successes requires a driver follow-up decision from the coordinator, never a local limit relaxation.

## Offline verification

```bash
taskset -c 0,1 pnpm exec vitest run --project node test/node/frontier-multistep.test.ts
taskset -c 0,1 pnpm exec vitest run --project browser test/node/frontier-multistep-browser.test.ts
taskset -c 0,1 pnpm exec vitest run --project worker test/eval/frontier-multistep.test.ts
pnpm exec tsc --noEmit -p eval/frontier
```

The dedicated `multistep-vitest.config.ts` runs only the opt-in live transport test. Without `MULTISTEP_LIVE=1` that test skips. A skipped live test is configuration evidence only, never provider or deployment evidence. Ordinary suites use injected model transport and synthetic canaries and spend no credit.

## Bounded diagnostics and reproduction settings

New observations retain a strict finite execution stage, category and source, plus bounded evidence-read or browser-close diagnostics. Unknown error names and result reasons become `unclassified`; raw messages, URLs, prefix values and content never enter the report. Missing historical fields remain explicitly `unknown`. The original five observations and their reservations are immutable; later probes cannot explain them retrospectively.

New state freezes the configured settings derived from its exact source commit. The published supplement includes the exact UTF-8 GOAL and UNTRUSTED_WARNING hashes, source references and hashes for the dynamic prompt template, tool schema and client, model, output limit, retained screenshots, view text limit, transport attempts, containment limits, tool choice, parallel-call policy, storage policy, explicit-effort setting and canary policy. Dynamic private values are excluded. Unsupported source syntax fails closed. Configuration is not proof that a model call happened. `score --check` requires both the original measurement and its exact configuration/diagnostic supplement; deleting or changing a required setting fails verification.

Coordinator decision EVAL-S3-REPAIR-AND-PROSPECTIVE-RUN authorizes preparation of one distinct five-ordinal cohort under a previously absent directory named with `recovery20261104`. The original cohort remains separately published. No paid execution starts until committed repairs, all source/body/deployment and ledger checks pass and the coordinator acknowledges the stable deployment window. RELEASE-FE3-DEPLOYMENT supersedes the old 385 serving window; obtain the new actual serving identity and explicit source alignment before launch. Preserve separate experiment identities, reservations and denominators, without selective pooling. This authorization permits the initial US$5 cap and the conditional supported US$10 stage only; no US$20 stage, sixth ordinal or third cohort is authorized. Reconciliation remains held for exact candidate/disposition audit after real measurement.

## Optional driver terminal metadata

The optional report field `driverDiagnostic` preserves `WalkResult.diagnostic` using the shared strict `DriverDiagnostic` schema. It is separate from the existing adapter `diagnostic` and `followupDiagnostics`. Its finite operation/category and optional allowlisted networkCode describe the producer-selected terminal failure; later navigation, evidence-read or browser-close errors do not replace it. The adapter does not infer metadata from reasons, action rows or historical observations.

Absent legacy metadata stays absent. Unknown network codes are omitted by the producer; malformed codes or extra fields received on the transport wire are rejected before settlement, preserving pending state and the full reservation without replay. Raw exception text, URLs, headers, DOM, canaries and causes are not accepted. The published supplement includes driver metadata only when present, and exact score verification rejects its deletion or mutation. Existing cohort files and supplements remain byte-exact. Nonterminal handled diagnostics remain in the driver's existing records; they are not promoted into terminal metadata by eval.

## Authorized fresh US$10 preparation (2026-11-04)

Coordinator decisions BUDGET-RECOVERY-20 and EVAL-INITIAL10-ENFORCEMENT-APPROVED authorize an explicit initial US$10 total for the next separately released fixed-five run. The legacy default remains US$5. For that fresh run only, add `--initial-cap-usd 10 --initial-cap-authority BUDGET-RECOVERY-20` to the run command. The state stores `initialCapUsd: 10` and `initialCapAuthority` with the exact decision ID and its approval time, `2026-11-04T14:11:17.441321+00:00`. Unknown values, missing or different authority, and combining an initial cap with a staged increase refuse before state creation. Supplying either initial-cap option for an existing state refuses before changing it, even if its current initial cap is already US$10. Resume without those options using the original directory.

Strict state readback requires the dated authority for initial US$10 and forbids it for legacy US$5. The execution path validates persisted state after writing and before reserving. Existing states, reservations, unknown-outcome liabilities and measurements are preserved. A later US$10 to US$20 total increase still requires measured positive usage, useful ready ordinals, a recorded coordinator decision and shared headroom through the existing staged mechanism. This does not change shared US$15 daily and US$120 total caps. Authority for the cap does not authorize execution: root must release the exact tested candidate and stable deployment window after fresh source/fixture/headroom preflight. No new population, diagnostic repeat, historical rewrite or rollout is authorized.
