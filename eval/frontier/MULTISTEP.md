# Wonder multi-step experiment

D08 T03 §3 measures five contained Wonder walks through a synthetic cookie banner, human checkbox and document lure. The harness uses the existing driver with its unchanged eight-step and sixty-second limits. Reaching the credential page is different from submitting the canary-only form. Offline browser tests prove fixture behavior, not model success. No live measurement is recorded yet.

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

`score` recomputes numerator, denominator, steps, time and measured versus estimated cost from strict observations. Unknown attempts remain in the denominator as unsuccessful and explicitly incomplete. `score --check` refuses unknown outcomes or a log that differs from the computed entry. Publish the entry only after all five observations are accounted for. Fewer than four successes requires a driver follow-up decision from the coordinator, never a local limit relaxation.

## Offline verification

```bash
taskset -c 0,1 pnpm exec vitest run --project node test/node/frontier-multistep.test.ts
taskset -c 0,1 pnpm exec vitest run --project browser test/node/frontier-multistep-browser.test.ts
taskset -c 0,1 pnpm exec vitest run --project worker test/eval/frontier-multistep.test.ts
pnpm exec tsc --noEmit -p eval/frontier
```

The dedicated `multistep-vitest.config.ts` runs only the opt-in live transport test. Without `MULTISTEP_LIVE=1` that test skips. A skipped live test is configuration evidence only, never provider or deployment evidence. Ordinary suites use injected model transport and synthetic canaries and spend no credit.
