---
schema_version: 1
id: eval-runner
domain: 08-eval
status: active
title: "TODO-02 -- Eval Runner, Metrics, Ablation and Results"
track: day-6
---

# TODO-02 -- Eval Runner, Metrics, Ablation and Results

> **Goal:** One command pushes every labelled sample through the real deployed pipeline as an eval organisation, measures detection rate, false positive rate, per-category results, time to verdict (median and 95th percentile) and cost per case against the spec's targets, repeats the run with each Meta model switched off to measure what each contributes, shows the latest run and production counts on an eval dashboard, and records results with causes in `eval/RESULTS.md`.

> **Current state:** Measured 2026-10-26 20:00 SAST. Datasets come from D08 T01. Targets are in design spec 4.9: detection at least 95%, false positives at most 2%, forward to reply under 60 s median and 3 minutes at p95, cost under US$0.05 median and US$0.25 with a walkthrough.

## Inputs

- Design spec 4.9 (runner, metrics, dashboard, targets, model ablation), 4.10 (production counts), 5 (demo dashboard), `docs/manifesto.md` (a regression in a target blocks the change).
- -> XREF: D02 T06 §3 -- the provider listings whose false-positive rates the metrics report
- -> XREF: D08 T01 §7 -- the challenge set (`eval/sets/synthetic-challenge/`), scored apart from the main sets (D08 T02 §2)

## Outcome

- `pnpm eval:run` produces a run row with every metric; `pnpm eval:ablate` produces the ablation table; the eval dashboard and `eval/RESULTS.md` show both with the date and the commit.

**Adjacency:** list=applicable @ D08 T02 §4; document=applicable @ D08 T02 §5; settings=not-applicable (targets are spec constants); reporting=applicable @ D08 T02 §4; notifications=not-applicable (sends no notices of its own); permissions=applicable @ D08 T02 §4; audit=applicable @ D08 T02 §1; exchange=applicable @ D08 T02 §5; reverse=not-applicable (runs are append-only records)

**Adjacency rationale:** Runs are listed and reported on the eval dashboard (operator and public summary); `eval/RESULTS.md` is the carried document and the export; each run records commit, set version and cost (audit).

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Eval runner through the deployed pipeline | D08 T01 §1, D01 T03 §1 | [ ] |
| 2 | §2 | Metrics against the spec targets | §1 | [ ] |
| 3 | §3 | Model ablation runs | §2, D04 T01 §2 | [ ] |
| 4 | §4 | Eval dashboard with production counts | §2, D07 T01 §10 | [ ] |
| 5 | §5 | Fix the worst misses and record results | §3, §4 | [ ] |
| 6 | §6 | PDF forensics rates on payment documents | §2, D06 T02 §1, D06 T02 §4 | [ ] |
| 7 | §7 | Live eval runs | §1 | [ ] |

## 1. Eval runner through the deployed pipeline

> **Started:** 2026-11-01T01:31Z

**Corrected 2026-11-01** (validation against the tree, Claude Code): (1) the migration is not `0016_eval.sql`: the number is assigned by the coordinator's ledger (main has migrations up to 0064); (2) there is no result API, so the runner uploads each file to `/api/upload` (`src/intake/upload.ts`, multipart field `file`, answers `{caseId}`, 201 new or 200 repeat, 429 when the organisation's daily cases are used) and reads the outcome from D1 (`cases.status` done or partial and `cases.verdict`, `case_events` for the time, `model_spend` by case for the cost, `evidence` for `critical_found`), by `wrangler d1 execute --remote` as `scripts/lib/meta-budget.ts` does, never by a write that bypasses the API; (3) an uploaded `.eml` carries its headers (`sniff`: `headersAvailable`), so every sample, header-dependent included, goes through upload and the `check@` forward path is left to D09 T01 §1's live-mail test; (4) the eval organisation is a member organisation of its own (never Fynbos Freight, whose case list is the demo's) with one member, created through the product's own invite-code signup, and its session is kept in 1Password and read from the environment (`EVAL_SESSION_COOKIE`), never from argv or the repository; its daily case allowance is raised through the console's `daily_cases_override` (the checks lane's cap column) so a full run of 275 samples is admitted; (5) the run's cost is estimated from the last run's cost per case (US$0.08 when none), stated before spending and refused when the estimate passes the remaining shared day cap (`src/meta/caps.ts`, US$15 a day across lanes) or the run's own stated cap; (6) the runner takes its API and database as injected clients, so the stubbed test needs no network and the live run only needs the session.

A Node script (`tsx`) uploads each sample to the deployed upload API as the eval organisation (or sends it to `check@` for header-dependent samples), waits for the verdict, and stores per-sample results in D1 tables `eval_runs` and `eval_results` (spec 4.9). It sizes the run to the budget before starting.

**Phase:** 6
**Needs:** none
**Surface:** no

**Corrected 2026-11-01** (plan review, `docs/reviews/08-eval/D08-T02-s1.md`, 4 P1 and 3 P2; the checklist below replaces the original three items): (7) **allowance:** a paid plan admits 50 cases a day and the operator override stops at 50 (`PLAN_DAILY_CASES`, `setDailyCapOverrideStatement`), so 275 samples cannot be admitted in a day; the ceiling for the eval organisation is raised at its owner (D07 T08 §8, checks lane, asked through the coordinator) and until then the runner reads the organisation's remaining allowance and refuses a run larger than it before uploading anything; (8) **repeats:** `/api/upload` answers a same-day repeat of the same bytes, name and type with the first case (200, `repeat: true`); a run therefore records a repeat of a case from an earlier run as `stale-repeat`, never as a measurement, and the run is incomplete (a same-day rerun is refused with that reason; the next SAST day it is fresh), while a repeat of a case this run itself opened is the recovery of a lost response; (9) **outcomes:** a sample ends `done` or `partial` (a result with the verdict it has, null when none, kept in the denominator) or `refused` (upload status kept), `capped` (429), `timeout` (5 minutes), `stale-repeat` or `lost` (no case id); a run is `complete` only when every selected sample ended `done` or `partial`, else `incomplete` (exit 2) or `aborted`; exit 0 only for `complete`, 1 for a fault, 3 for a refusal before any upload; every case id is written the moment the upload answers (a journal in `build/eval-runs/`, temp-then-replace) so `--resume <run id>` polls stored cases without uploading again; upload 503s are retried 3 times with backoff, polling errors up to 5 in a row, a failed database write 3 times before the run is `aborted` with its journal kept; (10) **proof:** the stubbed tests inject distinct responses per sample and assert the exact rows read back (verdict, null verdict, ms, cost, critical), uniqueness of case ids, the `partial`, `timeout`, `capped`, `refused`, `stale-repeat` and lost-response paths, and the deployed check is `pnpm eval:run --verify <run id>`, which reads the run back from D1 and reconciles every selected sample with its case; (11) **provenance:** `commit` is the deployed commit from `/health`, `set_version` is a SHA-256 over the sorted `path:SHA-256(bytes)` and `labels.json` of each selected set, sample ids are set-qualified (`synthetic-sa/bec-payment-001.eml`), `eval_results.case_id` is kept, and `ms` is upload start to terminal case (analysis time; the forward-to-reply target is measured by D09 T01 §1's live mail, not here); (12) **budget:** the preflight reads the day, total and reserve caps through `spentStatement` and `refusingCap` (`src/meta/caps.ts`) with the estimate, requires `--cap-usd` (a positive number not above the remaining headroom), refuses before any upload, stops starting samples once the measured spend plus the estimate for the cases in flight would pass the cap, or the shared guard refuses, and ends `incomplete` (the cases already in flight, at most 4, finish, so the cap is checked before each start, not after each case); (13) **wiring:** `package.json` gains `"eval:run": "node eval/run.ts"` (Node strips types, as `scripts/org-plan.ts` runs; no `tsx`), options `--set`, `--limit`, `--cap-usd`, `--resume`, `--verify`, `--dry`, each validated, and the tests are in the Node project (`test/node/eval-run.test.ts`) with one invocation through the real package command; (14) the migration is `0067_eval.sql` (coordinator ledger).


**Corrected 2026-11-01** (completion review, `docs/reviews/08-eval/D08-T02-s1.md`; the coordinator's split, 03:47 SAST): (15) the live runs are their own section, §7, because production migrations come only from gated `main` at a stamp: this section is the runner, `0067_eval.sql` and the tests on injected clients and on the real schema in memory, and §7 creates the eval organisation and runs and verifies on the deployment; (16) the review's gaps are built here: a repeated `--set` is taken once; cost is the shared ledger's (`model_spend`, settled at actual, else the estimate, by case; `case_events.cost_usd` is not written by the pipeline) and is kept for a timeout or lost case; the stated cap must fit the shared headroom, and the shared caps are read again between admissions (`stopped early: shared`); a resume keeps a `stale-repeat` as it was; `ms` is the server's own `updated_at - created_at` of the case; the run row, every result, the unsent rows and the finish are stored with retries and a failure is `aborted` (exit 1), never success, and an unwritable journal aborts; the run row keeps the selection (`sets`, `sample_limit`) and a resume restores it and refuses another deployment (`/health` commit); a session must belong to the eval organisation alone (`/api/auth/get-session`, then `member`) before the first upload; every upload, health and database call is bounded (`boundedBy`); `http_status` and a safe `detail` are kept, and a local read failure is `lost`, not a 503; `--verify` reconciles cost, critical evidence, time, verdict and the run total against the ledger; the preflight figures (selected, estimate, cap, allowance, shared spend) and the run id with its resume command are printed before the first upload, then progress every 5 seconds; `--dry` states no cap.

**Corrected 2026-11-01** (second completion review): (17) an admission reserves its estimate synchronously, before any await, so four workers cannot all pass the same headroom; a shared-spend read that fails or is unanswered refuses the admission (`stopped early: shared`), and concurrent admissions share the one read in flight; a resume keeps the cap the run began with and refuses another (`--resume` needs no `--cap-usd`); a repeated upload is judged before its case is journaled, so an interruption finds it again as a repeat on resume; progress lines are driven by elapsed time in every wait, not by finished results. Round 1 (3 P2, P3): (18) a repeated case whose age cannot be read is `lost` and retried on resume, never `stale-repeat` for good; the admission gates (budget, shared headroom, the stop) apply to a new upload only, a case already opened is reconciled whatever the budget says, and a sample the run does not reach keeps the row an earlier pass stored, with its case and recorded cost; a timer (`env.ticker`) prints the progress line every five seconds whatever is pending.

> **Deferred:** the runs on the deployment and their verification, the fresh-SAST-day schedule for a full run after the ten-sample run (a same-day overlap is a `stale-repeat`) -> XREF: D08 T02 §7

**Build order:**

1. Add the migration and its test. Done when: it applies and refuses a duplicate result.
2. Write the pure core with its tests. Done when: an oversized run is refused before any upload.
3. Write the runner on injected clients. Done when: the stubbed run stores exactly the injected rows.
4. Wire the package command. Done when: `pnpm eval:run --help` runs through the real package command.

- [x] Add migration `src/db/migrations/0067_eval.sql` with `eval_runs` (`id`, `commit_sha`, `set_version`, `mode` full or an ablation name, `status` complete, incomplete or aborted, `selected`, `cap_usd`, `started_at`, `finished_at`, `cost_usd`) and `eval_results` (`run_id`, `sample` set-qualified, `case_id`, `outcome`, `label`, `category`, `verdict`, `ms`, `cost_usd`, `critical_found`, primary key `run_id, sample`). Done when: it applies on a fresh D1 and the migration test refuses a duplicate `run_id, sample`, an unknown `outcome` and a `complete` run row with `finished_at` null. Done 2026-11-01: applies in `test/node/eval-run.test.ts`, which refuses a duplicate result, an unknown outcome, an unqualified sample and a complete run with no finish time.
- [x] Write the pure core `eval/run-core.ts`: sample selection with set-qualified ids and `set_version`, the cost estimator and preflight against the day, total and reserve caps and the organisation's remaining allowance, and the outcome and run-status rules. Done when: `test/node/eval-run.test.ts` refuses a run over any cap or over the allowance before an upload, and derives `complete`, `incomplete` and the exit codes from distinct outcome sets. Done 2026-11-01: preflight, estimator, status, exit codes and option validation tested in `test/node/eval-run.test.ts` (a run over any cap or the allowance is refused before an upload; mutation: a status counting a timeout as complete fails 4 tests).
- [x] Write `eval/run.ts` (the `eval:run` command): upload with the eval session from `EVAL_SESSION_COOKIE` at concurrency 4, journal each case id, poll each case to a terminal state with a 5-minute cap, retry as corrected, store `eval_runs` and `eval_results`, `--resume` and `--verify`. Done when: with an injected API and database the 10-sample run stores 10 rows equal to the injected responses (including a null verdict and a partial case), a repeat of an earlier run's case is `stale-repeat`, a lost upload response is recovered by `--resume` without a second case, and an interrupted run is `incomplete`, never `complete`. Done 2026-11-01 on injected clients: exact read-back of 10 distinct responses, partial, timeout, capped, refused, stale-repeat, lost-response recovery, session abort with resume, write failure, budget stop and `--verify` (mutation: no stale-repeat check fails its test). The live run is the last item.
- [x] Add `eval:run` to `package.json` and the option validation. Done when: `pnpm eval:run --help` and `pnpm eval:run --limit 0` behave as the test states (usage, exit 3 on a refused option) through the real package command. Done 2026-11-01: `pnpm eval:run --help` exits 0 and `--limit 0` exits 3 through the real package command in the test.
- [ ] Commit: `eval: runner through the deployed pipeline`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/eval-run.test.ts` passes (injected API and database, and the live adapter on the real schema in memory) and fails when a result row differs from its injected response, a partial run reports `complete`, a stale repeat is measured on resume, or a session outside the eval organisation uploads. The deployed run is D08 T02 §7.

## 2. Metrics against the spec targets

Detection rate on attacks, false positive rate on genuine mail (suspicious or malicious on a genuine sample counts as a false positive), per-category results, median and p95 time, median cost and median cost with a walkthrough, each compared with its target; plus each reputation provider's false-positive rate on our data (spec 4.3a).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write `eval/metrics.ts`. Done when: a seeded run computes every metric and marks each target met or missed.

- [ ] Compute detection, false positives, per-category tables, median and p95 ms, median cost overall and with a walkthrough. Done when: `test/eval/metrics.test.ts` checks a seeded run.
- [ ] Compute per-provider false-positive rates from listings on genuine samples and from feedback. Done when: the seeded run reports them.
- [ ] Mark each target met or missed with the spec's numbers as constants. Done when: the output lists each target.
- [ ] Report the result cache's effect (D03 T01 §4): hits and misses per run, hit latency median and p95 (the KV read, the validation and the hit's record) beside the miss path's, and the model spend the hits avoided, from the `model_spend` rows (`cache = 'hit'`). The cache claims cost avoidance only; no speed claim is made until this measures it. Done when: the seeded run's output shows the hit rate, both latencies and the avoided spend. Source: D03 T01 §4 completion review (G4).
- [ ] Report intake time apart from analysis time (the email handler's own run, from delivery to the Workflow's start) for small forwards and for one near the 25 MiB limit. Done when: the seeded run's output shows intake median and p95 by size band. Source: D01 T01 §3 completion review (Part 2 item 3).
- [ ] Report `content.ai_instructions` (D02 T05 §2) on its own: precision and recall on the corpus's injection and genuine cases, and the checks step's median and p95 time with the most text attachments it reads (D02 T05 §2's limits). Done when: the results file has the row. Source: D02 T05 §2's completion review (G14), 2026-10-31.
- [ ] Report `attachment.type_mismatch` and the archive checks (D02 T04 §1, §3, §5) on their own: misses and false positives over valid files of each identified format, disguised ones and damaged packages, and the checks step's p50 and p95 time with the most attachments it reads. Done when: the results file has the row. Source: D02 T04 §5's completion review, 2026-10-31.
- [ ] Report the retry's latency (D01 T01 §17): a retried check's time from the member's request to its result, median and p95, against the median-under-60-seconds and p95-under-three-minutes targets, and the time an interrupted retry takes to be settled. Done when: the results file has the row. Source: D01 T01 §17's completion review (G10), 2026-10-31.
- [ ] Report invisible-character detection (D02 T05 §3) on a reproducible set of tag payloads, malformed runs, multilingual and emoji controls and chunk boundaries: detections, false positives, and the checks step's p50 and p95 time and peak memory with the largest accepted message. Done when: the results file has the row. Source: D02 T05 §3's completion review (G6), 2026-10-31.
- [ ] Score a label of basis `model` (D08 T01 §4) on the verdict alone: an attack counts as detected when the case's verdict is suspicious or malicious, whatever evidence it cites, and is never scored on `expected` (which it may leave empty); report `model`-basis detection apart from `checks`-basis detection, so the share only a model can catch is visible. Done when: the metrics test scores a fixed set holding both bases to exact numbers, a `model` attack verdicted safe counts as missed, and one verdicted suspicious with no cited evidence counts as detected.
- [ ] Score the challenge set (D08 T01 §7, folder `synthetic-challenge`) on its own, never pooled: its own detection, false-positive and per-category figures with their own denominators, and its samples left out of the main sets' totals and targets. Done when: the metrics test scores a fixed run holding both populations to exact numbers (challenge recall, challenge false-alarm rate, main recall and false-alarm rate, each with its denominator), and fails if a challenge sample is counted in a main figure or a main sample in a challenge one; and it reports the pairs both right (an attack caught and its matched control passed) out of 30, with the checks-only figures beside the model-enabled ones, so a pair a model separates only by understanding its tell is visible (exact numbers on a fixed run, a pair with one member wrong not counted). Source: D08 T01 §7's plan review (2026-10-31) and completion review (G5, 2026-11-01).
- [ ] Commit: `eval: metrics against the spec targets`

**Test checkpoint:** `pnpm exec vitest run test/eval/metrics.test.ts` passes and fails if a suspicious verdict on a genuine sample is not counted as a false positive.

## 3. Model ablation runs

The manifesto's first priority made measurable (spec 4.9): rerun the eval with each Meta model switched off in turn (Muse Spark reasoning replaced by the rule-based verdict, no Muse Wonder walkthrough, no SAM 3.1 comparison, no Voice Transcribe, no Loupe page screening (Muse Spark screens every page instead); corrected 2026-10-28 20:45 SAST, was Spark page screening, now the failover behind Loupe; corrected 2026-10-27, was Glimmer) and record what each removal costs in detection, false positives, time and cost. A model whose removal costs nothing is cut or reworked.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Add ablation switches. Done when: each switch disables exactly its model for eval-organisation cases only.
2. Run and tabulate. Done when: `eval/RESULTS.md` has the ablation table.

- [ ] Add per-case `ablate` flags (set only for the eval organisation via the runner) honoured by the agent, walkthrough, SAM, voice and screening steps. Done when: `test/eval/ablation.test.ts` shows each flag skips only its model.
- [ ] Run `pnpm eval:ablate` on a budget-sized subset (stratified by category) for each switch. Done when: one run row exists per switch.
- [ ] Write the table (model removed, detection change, false-positive change, time change, cost change) to `eval/RESULTS.md` and act on any zero-contribution model by filing a section through `add-todo`. Done when: the table exists and any such model has a filed section.
- [ ] Commit: `eval: model ablation runs`

**Test checkpoint:** `pnpm exec vitest run test/eval/ablation.test.ts` passes and `grep -c 'Model removed' eval/RESULTS.md` prints at least `1`.

## 4. Eval dashboard with production counts

The dashboard shown in the demo (spec 4.9, 4.10, 5): the latest full run's metrics against targets, the ablation table, and production counts since 27 Oct (cases, verdict mix, median time, invoice flags; counts only, never content). The operator sees all runs in `/admin`; a public summary page shows the latest run.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` eval dashboard
**Job:** a judge sees measured accuracy, cost and each model's contribution at a glance
**Treatment:** targets beside results, met or missed said plainly, dates and commit shown
**Chrome:** `AppShell` and uPlot charts from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `/eval` (public summary) and `/admin/eval` (all runs). Done when: a seeded database renders both.

- [ ] Build `src/web/pages/eval.tsx` with the targets table, per-category chart, ablation table, run date and commit. Done when: `test/web/eval-page.test.ts` checks each.
- [ ] Add production counts from `cases` (all organisations, counts only) since 2026-10-27. Done when: the page shows them and a grep test finds no subject or sender field in the query.
- [ ] Build `/admin/eval` listing all runs behind Access. Done when: the access test refuses it without Access.
- [ ] Write `eval/results-summary.json` from the same run `/eval` shows (asked 2026-10-31 by the coordinator for the site lane's home page results band, D07 T06 §2, which reads it at build time): `{ "detectionRate": number 0..1, "falseAlarmRate": number 0..1, "medianSeconds": number, "samples": integer, "runDate": "YYYY-MM-DD", "runId": string }`, written temp-file-then-rename by `writeResultsSummary` in `eval/run.ts`. Done when: `test/node/eval-results-summary.test.ts` reads the file back and finds each field equal to the figures `src/web/pages/eval.tsx` renders for that run, and refuses a summary from another run id. Cheaper substitute: none.
- [ ] Commit: `web: eval dashboard with production counts`

**Test checkpoint:** `pnpm exec vitest run test/web/eval-page.test.ts` passes and fails if production counts include message content.

## 5. Fix the worst misses and record results

Run the full set, read the misses and false positives, fix the worst causes at their owning layer (each fix with a regression sample), rerun, and record before and after with causes for any missed target in `eval/RESULTS.md` (spec 4.9).

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Full run and triage. Done when: `eval/RESULTS.md` lists every miss and false positive with its cause.
2. Fix and rerun. Done when: the after-run is recorded beside the before-run.

- [ ] Run the full set and write the before-table and a triage list (sample, expected, got, cause, owning layer). Done when: the list exists.
- [ ] For each of the five most common causes, file or fix through the TODO system at the owning layer with a regression sample added to the set. Done when: each cause names a commit or a filed section.
- [ ] Rerun and write the after-table with targets met or missed and causes for any miss. Done when: the after-table exists.
- [ ] Commit: `eval: worst misses fixed and results recorded`

**Test checkpoint:** `grep -cE '^\| (Detection|False positives)' eval/RESULTS.md` prints at least `2`.

## 6. PDF forensics rates on payment documents

The trust lane's PDF forensics (D06 T02 §1, `src/invoice/forensics.ts`: `analysePdf` and `forensicsEvidence`, checking `document.forensics.revisions`, producer, dates, fonts and overlay) measured for detection and false positives on payment documents, by document type (proof of payment, bank letter, invoice) and by generator, against design spec 4.9's targets (detection at least 95%, false positives at most 2%). Filed 2026-10-31 at the trust lane's request through the coordinator: their completion review had pointed it at D08 T01 §3, the synthetic mail set, which is not its home. The checks are deterministic, so this measures them directly on the documents, not through the deployed pipeline, and spends nothing.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Run `analysePdf` over every genuine and doctored payment document, score it by type and generator against the targets, and record the result. Done when: `eval/RESULTS.md` holds the table, and every cell below a target is filed at its owner.

- [ ] Read the fixtures and their provenance (`test/fixtures/pdf-forensics/`, D06 T02 §1) and the doctored pairs (D06 T02 §4): list each document with its type, generator, genuine or doctored, and which edit was made. Done when: `eval/sets/pdf-forensics/manifest.json` names every document with those fields and its sha256, and the set's licence and provenance are recorded in `eval/DATASETS.md`.
- [ ] Write `eval/forensics/score.ts`: `analysePdf` on each document, a document flagged when `forensicsEvidence` yields any finding at or above the severity the verdict uses; detection over the doctored, false positives over the genuine, each by document type and by generator, with the count behind every rate. Done when: `test/node/eval-forensics.test.ts` scores a fixed set of stub analyses to exact numbers, and fails when a genuine document's finding is not counted as a false positive.
- [ ] Use D08 T02 §2's metric helpers for the rates and the target comparison, so this table reads like the main eval's. Done when: the test finds the same rate from both for one fixed input.
- [ ] Refuse to score a set whose manifest hashes do not match the files, or whose documents lack a type or generator. Done when: the test finds each refused, naming the document.
- [ ] Run it and write the table into `eval/RESULTS.md`: rows by document type and by generator, detection and false positives with counts, the targets, the set's size and its limit (a set this small cannot show 2% false positives on its own). Done when: the table is there and `node eval/forensics/score.ts --check eval/RESULTS.md` passes.
- [ ] File every cell below a target through `add-todo` at the trust lane's D06 T02 (the forensics' owner), through the coordinator. Done when: each miss names its filed section, or the table has none.
- [ ] Commit: `eval: PDF forensics rates on payment documents`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-forensics.test.ts` passes and fails when a genuine document's finding is not counted as a false positive, and `node eval/forensics/score.ts --check eval/RESULTS.md` exits 0 on the committed table (a rate or count that differs from the score exits 1).

## 7. Live eval runs

Filed 2026-11-01 from D08 T02 §1 (the coordinator's split: production migrations come only from gated `main` at a stamp, so the runner, `0067_eval.sql` and the stubbed tests stamp first, and the deployed runs are this section). It creates the eval organisation through the product's own invite signup, signs it in once, keeps its session in the vault, and runs `pnpm eval:run` against the deployment under a cap stated before each run, then verifies each run against its cases.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Create the eval organisation and its session. Done when: a read of the member's own cases through the cookie answers 200 and the session belongs to that organisation alone.
2. Run ten samples and verify them. Done when: `pnpm eval:run --limit 10 --cap-usd 0.80` stores 10 results and `--verify` exits 0.
3. Run the full set under a stated cap and verify it. Done when: the run is `complete` and `--verify` exits 0.

- [ ] Create the 'IsItLegit Eval' organisation with one member, `eval@isitlegit.co.za` (an Email Routing alias forwarding to `hostmaster@rizonetech.com`), by the invite signup (`scripts/invite-code.ts`; the one-use code is in the vault item "IsItLegit demo invite code", read without printing); sign it in once by reading the code from `derick@rizonetech.com`; keep the session cookie only in the new Conclave vault item "IsItLegit eval session" (piped, never printed, never in argv, the repository or a log). Never Fynbos Freight; `demo@rizonetech.com` and `derick@rizonetech.com` are never touched. Done when: the runner's own session check passes (the session belongs to the eval organisation alone) and a read of the member's cases answers 200.
- [ ] Ask the coordinator to set the eval organisation's daily-cases override (the operator's knob, ceiling raised to 500 by the console lane) to at least the samples in a full run. Done when: `pnpm eval:run --dry` reports the allowance and the full run is not refused for it.
- [ ] State the cap, then run `pnpm eval:run --limit 10 --cap-usd 0.80` (10 samples at the US$0.08 default estimate); the full run follows on a fresh SAST day, because a same-day repeat of the same files is a `stale-repeat`, or uses a different selection. Done when: the run stores 10 results, `pnpm eval:run --verify <run id>` exits 0, and the run file records the run id, commit, cost and the cap stated before it.
- [ ] State the cap, then run the full set (the cap is the estimate from the first run's cost per case times the samples, with a margin, never above the shared day headroom). Done when: the run is `complete`, `--verify` exits 0, and `eval_runs` holds its row with the deployed commit and set version; a run left `incomplete` is resumed with `--resume` until complete or its cause is recorded and filed.
- [ ] Commit: `eval: live eval runs`

**Test checkpoint:** `pnpm eval:run --verify <run id>` exits 0 for the ten-sample run and for the full run.

## Verification

- The eval runs on the deployed system, reports every target and each model's contribution, and the results are public on the dashboard and in `eval/RESULTS.md`.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
