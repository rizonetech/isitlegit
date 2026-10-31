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
- -> XREF: D08 T01 §7 -- the challenge set the runner scores on its own line

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

## 1. Eval runner through the deployed pipeline

A Node script (`tsx`) uploads each sample to the deployed upload API as the eval organisation (or sends it to `check@` for header-dependent samples), waits for the verdict, and stores per-sample results in D1 tables `eval_runs` and `eval_results` (spec 4.9). It sizes the run to the budget before starting.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Write `eval/run.ts`. Done when: a run on a 10-sample subset stores 10 results.
2. Guard the budget. Done when: the runner refuses a run whose estimated cost exceeds the remaining day cap.

- [ ] Add migration `0016_eval.sql` with `eval_runs` (`id`, `commit`, `set_version`, `mode` full or ablation name, `started_at`, `finished_at`, `cost_usd`) and `eval_results` (`run_id`, `sample`, `label`, `category`, `verdict`, `ms`, `cost_usd`, `critical_found`). Done when: it applies.
- [ ] Write `eval/run.ts` using an eval organisation session, uploading samples with concurrency 4, polling each case to completion with a 5-minute cap, and recording results. Done when: `pnpm eval:run --limit 10` stores 10 results.
- [ ] Estimate cost per sample from the last run (or US$0.08 if none) and refuse when the estimate exceeds the remaining daily cap. Done when: a test of the estimator refuses an oversized run.
- [ ] Commit: `eval: runner through the deployed pipeline`

**Test checkpoint:** `pnpm exec vitest run test/eval/run.test.ts` passes (stubbed API) and `pnpm eval:run --limit 10` exits 0 on the deployment.

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

## Verification

- The eval runs on the deployed system, reports every target and each model's contribution, and the results are public on the dashboard and in `eval/RESULTS.md`.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
