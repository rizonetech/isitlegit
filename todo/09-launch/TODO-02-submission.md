---
schema_version: 1
id: submission
domain: 09-launch
status: active
title: "TODO-02 -- README, Contributions, Video Assets and Submission Package"
track: day-6
---

# TODO-02 -- README, Contributions, Video Assets and Submission Package

> **Goal:** Everything the submission needs that Claude can build is finished by Wed 4 Nov 12:00 SAST: `CONTRIBUTIONS.md` by day with commit ranges, `NOTICE.md` audited against every dependency, the final README with the architecture diagram, Meta model use and results, the demo script, the Remotion title cards and architecture animation rendered to MP4, and the final eval run with its dashboard screenshot; the operator records, assembles and submits (D99 T02).

> **Current state:** Measured 2026-10-26 20:00 SAST. `CONTRIBUTIONS.md`, `NOTICE.md` and the README exist from D00 T01 §1 as the starting versions.

## Inputs

- `docs/hackathon-criteria.md` (rules and scoring), design spec 5 (demo script), plan Day 8 and Day 9, stack doc (Remotion 4.0.539 pinned to 4.x, Free License for Rizonetech's team of three).
- -> XREF: D99 T02 §3 -- the operator records the demo with the script and assets from this file

## Outcome

- The repository tells a judge, in its README, what IsItLegit is, how each Meta model is used, what was built when, the measured results and how to verify them; the video assets and script are ready for the operator.

**Adjacency:** all=not-applicable (submission documents and assets; no product records)

**Adjacency rationale:** These are repository documents and media for the submission.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | CONTRIBUTIONS.md by day, commit ranges | D09 T01 §3 | [ ] |
| 2 | §2 | NOTICE.md audited against each dependency | D09 T01 §3 | [ ] |
| 3 | §3 | Demo script and model-trace demo mode | D07 T03 §5, D07 T07 §2 | [ ] |
| 4 | §4 | Remotion title cards and animation | §3 | [ ] |
| 5 | §5 | Final eval run and dashboard screenshot | D08 T02 §5 | [ ] |
| 6 | §6 | Final README | §1, §2, §5 | [ ] |
| 7 | §7 | Detection finetuning from the final miss analysis | D08 T02 §5 | [ ] |
| 8 | §8 | Demo path polish: report, trace and timing | §3, D08 T02 §5 | [ ] |
| 9 | §9 | Final polish sweep: a11y, performance, wording | §8 | [ ] |
| 10 | §10 | Independent validation by an outsider | D08 T02 §10, §5 | [ ] |
| 11 | §11 | Automated demo rehearsal, three clean runs | §3, §8, D09 T01 §2 | [ ] |
| 12 | §12 | Ablation chart for the results and README | D08 T02 §3, §5 | [ ] |
| 13 | §13 | Judge no-account demo: recorded replay from the repo | §6, D08 T02 §10 | [ ] |

## 1. CONTRIBUTIONS.md by day, commit ranges

**Corrected 2026-10-28:** the title read "CONTRIBUTIONS.md by day with commit ranges"; shortened by a word so the Phase 6 plan table stays within 100 characters once 11-character references (D01 T01 §10, D05 T04 §10) joined it.

The rule "identify your contributions" (`docs/hackathon-criteria.md`): what was built each day with its commit range, the pre-existing development tooling declared separately, and third-party code and data listed with licences.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** `scripts/contributions.ts` does not exist, and by D09 T01 §1's correction (`scripts/` is shared tooling this lane does not write) its home needs the same ruling before it is built; the checkpoint also under-counts: 26 Oct to 4 Nov inclusive is 10 days, so "at least 9" rows would pass with a day missing.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Generate the day table from git. Done when: `CONTRIBUTIONS.md` lists each day from 26 Oct with its first and last commit and the features shipped.

- [ ] Write `scripts/contributions.ts` reading `git log` grouped by SAST day with the TODO section refs in commit bodies. Done when: it prints a table per day.
- [ ] Update `CONTRIBUTIONS.md` with the table, keeping the pre-existing tooling section. Done when: every day since 26 Oct has a row.
- [ ] Commit: `launch: CONTRIBUTIONS.md by day with commit ranges`

**Test checkpoint:** `grep -cE '^\| (Mon|Tue|Wed|Thu|Fri|Sat|Sun) ' CONTRIBUTIONS.md` prints at least `9`.

## 2. NOTICE.md audited against each dependency

**Corrected 2026-10-28:** the title read "NOTICE.md audited against every dependency"; shortened by a word so the Phase 6 plan table stays within 100 characters once 11-character references (D01 T01 §10, D05 T04 §10) joined it.

Every runtime and development dependency in the lockfiles, every vendored file and every dataset is listed with version and licence, and checked against our use (`docs/hackathon-criteria.md`: rights to everything used).

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** the checkpoint cannot run (`tsx` is not a dependency; use `node`) and the stated method cannot work: `pnpm-lock.yaml` carries no licence fields, so the script must read each package's own `package.json` (or `pnpm licenses`). `scripts/check-notice.ts` does not exist and its home needs the D09 T01 §1 ruling.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Generate the dependency list and compare with `NOTICE.md`. Done when: a script reports no unlisted dependency.

- [ ] Write `scripts/check-notice.ts` listing direct dependencies from `pnpm-lock.yaml` with their licence fields, and failing on any not in `NOTICE.md` or with a licence outside an allowlist (MIT, Apache-2.0, BSD, ISC, OFL, Unicode, CC BY for data). Done when: it passes.
- [ ] Fill `NOTICE.md` with every row. Done when: the script passes.
- [ ] Commit: `launch: NOTICE.md audited against every dependency`

**Test checkpoint:** `pnpm exec tsx scripts/check-notice.ts` exits 0.

## 3. Demo script and model-trace demo mode

The 3-minute script from spec 5, updated for the decisions (fictional mail provider, no WhatsApp, voice note upload): exact fixtures, which inbox forwards what, what appears on screen when, the model-trace panel open (`?trace=1`), and the uncut forward-to-reply take with an on-screen clock.

> **Started:** 2026-10-31T16:00Z (media lane; design: `docs/specs/2026-10-31-demo-video-design.md`)

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write `docs/demo-script.md`. Done when: each beat names its fixture, its screen and its Meta model.

- [ ] Write the beats with timings (problem, forward and reply with walkthrough replay, hidden-text evidence, invoice bank change, impersonation alert, voice note upload, safe mail, eval dashboard with ablation, what was built and how Meta is used). Done when: the file exists and totals 3 minutes or less.
- [ ] Add the voice decoder claim to the voice note upload beat of `docs/demo-script.md`: "For voice-note intake inside a Worker, our decoder finishes faster than calling FFmpeg on every input we benchmarked, mainly because it decodes Opus straight to 16 kHz and runs in-process." Source: the D01 T03 §9 bench (medians of three, CI run 40602990459 at `335df7e`, FFmpeg 6.1.1-3ubuntu5); re-read the latest bench run recorded in §9 first, since `bd81843` added a 25 MiB WAV at 44,101 Hz, and narrow the wording if any row no longer holds. The on-screen caption names the CI run, the FFmpeg version and that FFmpeg's times include starting its process; the claim says nothing about output quality, which the bench does not compare. Done when: the beat carries the line and its caption, and every row of the cited run shows ours finishing first.
- [ ] Add a "demo clock" overlay on the report page when `?clock=1` showing elapsed time since the case was received. Done when: `test/web/demo-clock.test.ts` renders it only with the flag.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** neither `docs/demo-script.md` nor `test/web/demo-clock.test.ts` exists yet. The voice-claim item's cited bench (CI run 40602990459 at `335df7e`) is superseded by D01 T03 §9's latest (CI run 40606229380 at `bd81843`, ahead on all eleven inputs); the item already says to re-read §9, and the caption must use the latest run. The demo-clock item names no file: the overlay lives in `src/web/pages/report-view.tsx`, with the `?clock=1` flag plumbed from the page route.
- [ ] Commit: `launch: demo script and demo mode`

**Test checkpoint:** `pnpm exec vitest run test/web/demo-clock.test.ts` passes.

## 4. Remotion title cards and animation

Title cards, the animated architecture diagram and the model-trace highlight cards in Remotion 4.x (`media/`), rendered to MP4 for the demo video (plan Day 8).

**Corrected 2026-10-31 (coordinator, 21fc5c8d):** the section moved to the media lane and lives in the existing `media/` Remotion root, not a new `video/` workspace package: `media/` already pins `remotion` and `@remotion/cli` 4.0.539 and holds the brand kit, fact pinning and voice pipeline, so a second install would duplicate them.

> **Started:** 2026-10-31T16:00Z (media lane; design: `docs/specs/2026-10-31-demo-video-design.md`)

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Build the demo compositions in `media/`. Done when: `cd media && pnpm render:demo` writes the MP4 files.

- [ ] Add a `render:demo` script to `media/package.json` that renders the demo compositions from `media/src/index.ts` (exact `remotion` and `@remotion/cli` 4.0.539, the IsItLegit fonts and tokens; the Remotion Free License basis is recorded in D10 T01 §2). Done when: `cd media && pnpm render:demo` runs.
- [ ] Build compositions: opening title, architecture diagram (intake, Workflow steps, each Meta model, reply), one card per Meta model, and the closing card with the repository URL. Done when: each renders.
- [ ] Render to `media/out/demo-*.mp4` (git-ignored) and list them in `docs/demo-script.md`. Done when: the files exist.
- [ ] Commit: `media: demo title cards and architecture animation`

**Test checkpoint:** `cd media && pnpm render:demo && ls out/demo-*.mp4 | wc -l` prints at least `4`.

## 5. Final eval run and dashboard screenshot

The last full eval run on the final deployment, its numbers in `eval/RESULTS.md`, and a dashboard screenshot for the README (plan Day 9).

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** `eval/RESULTS.md` does not exist and two writers claim it: this section and `writeAblationResults` in `eval/ablate.ts:235` (D08 T02's record); the final-run table and the ablation table need distinct paths or one named owner before either writes. `docs/images/` does not exist yet either. Media keeps §3 and §4 (coordinator, START WAVE 1), so §4's Remotion build is not this lane's despite the file claim.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Run and capture. Done when: `eval/RESULTS.md` has the final table and `docs/images/eval-dashboard.png` exists.

- [ ] Run `pnpm eval:run` on the full set (within the reserve budget for 3 and 4 Nov). Done when: a run row exists with the final commit.
- [ ] Capture the `/eval` page with Browser Run at 1280 px to `docs/images/eval-dashboard.png`. Done when: the image exists.
- [ ] Commit: `eval: final run and dashboard screenshot`

**Test checkpoint:** `test -f docs/images/eval-dashboard.png && grep -c 'Final run' eval/RESULTS.md` prints at least `1`.

## 6. Final README

The README a judge reads first: the problem, the demo video link (added by the operator), the architecture diagram, each Meta model and its job with the ablation numbers, the measured results, what was built during the event, third-party libraries and datasets, how to verify, and the judge demo organisation instructions (code in the submission, not the repository).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Rewrite the README sections. Done when: every section above exists with working links.

- [ ] Replace the status note with the launch state and results summary. Done when: the note names the final eval numbers and date.
- [ ] Add the architecture diagram (Mermaid or the Remotion still) and the Meta model table with ablation results. Done when: both render on GitHub.
- [ ] Add "Verify it yourself" (eval command, dashboard URL, judge demo sign-in steps). Done when: the section exists.
- [ ] Check every link and figure has a source (`AGENTS.md`, manifesto: evidence over assertion). Done when: a link check script passes.
- [ ] Commit: `launch: final README`

**Test checkpoint:** `pnpm exec tsx scripts/check-links.ts README.md` exits 0.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** this checkpoint cannot run: no `tsx`, no `scripts/check-links.ts`, and the script's home needs the D09 T01 §1 ruling. If the architecture diagram uses §4's Remotion still, §6 also depends on §4; the Depends On column (§1, §2, §5) must say so when that choice is made. The README status note still reads day 0 while the service is live (health at `165cf2e8`); the coordinator's §13 filing note says that fix rides with this section, or earlier if the README is touched.

## 7. Detection finetuning from the final miss analysis

Phase 8 (operator, 2026-11-02): after the eval chain measures the chained models (D08 T02 §3 ablation, §5 worst-miss fixes), tune what the misses actually show, prompt wording, reasoning effort per call, check thresholds above the deterministic floor, and re-measure. No tuning without a before and after number on the same set version.

**Phase:** 8
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Tune from evidence. Done when: each change names the miss class it answers and its measured effect.

- [ ] Take the miss classes from D08 T02 §5's record in `eval/RESULTS.md`. Done when: every tuned change cites a miss class and count. Cheaper substitute: tuning from anecdotes, refused.
- [ ] Apply the tuning in the owning layer (prompt in `src/agent/`, effort in the call site, threshold in `src/checks/`). Done when: no change touches the deterministic floor in `src/agent/floor.ts`. Cheaper substitute: post-hoc verdict filtering, refused.
- [ ] Re-run the full eval on the same set version and record before and after in `eval/RESULTS.md`. Done when: detection, false alarms, median time and cost are printed for both.
- [ ] Commit: `launch: detection finetuning from the final miss analysis`

**Test checkpoint:** `grep -c 'Finetuning' eval/RESULTS.md` prints at least `1`, and the eval suite for the touched layer passes.

## 8. Demo path polish: report, trace and timing

Phase 8 (operator, 2026-11-02): the exact path the 3 minute demo walks, forwarded mail to cited verdict with the model trace, polished until it is flawless on the live service: wording, trace readability, timing inside the spec 4.9 targets, and every state (partial, failed, recovered) designed.

**Phase:** 8
**Needs:** cloudflare, meta-api
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 Report and S10 Results: verdict banner, three reasons, actions, model trace
**Job:** a judge watching the demo sees each model at work and believes the verdict
**Treatment:** verdict first, then what to do, then the cited evidence and trace, in plain words
**Chrome:** the existing report page and public eval page shells, no new surface

**Build order:**

1. Polish the demo path. Done when: a live run of the demo script (§3) shows no placeholder, raw error or unexplained wait.

- [ ] Walk the demo script (§3) live and list every rough edge in `docs/phase-runs/`. Done when: the list exists with one line per edge. Cheaper substitute: polishing from screenshots, refused.
- [ ] Fix each edge in its owning layer (wording in `src/web/pages/report-view.tsx`, trace in the trace component, timing in the step that waits). Done when: the re-walk shows none left. Cheaper substitute: demo-only special cases in product code, refused.
- [ ] Prove the partial and failed states on the same path (a model outage yields a marked partial report). Done when: the walk record shows both.
- [ ] Commit: `launch: demo path polish`

**Test checkpoint:** `grep -c 'demo walk' docs/phase-runs/*submission*.md` prints at least `1` after the live §3 demo walk, with the verdict time inside the spec 4.9 targets.

## 9. Final polish sweep: a11y, performance, wording

Phase 8 (operator, 2026-11-02): the last sweep over the shipped surfaces before submission: WCAG 2.2 AA on the demo and report surfaces, page weight on a mid-range phone, and plain-language wording a busy owner reads once.

**Phase:** 8
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 Report and S10 Results surfaces at phone and desktop widths
**Job:** a busy owner reads the answer once, on a phone, and acts
**Treatment:** one design language from tokens only, every state designed, no raw errors
**Chrome:** the existing report page and public eval page shells, no new surface

**Build order:**

1. Sweep and fix. Done when: every check below passes on the final deployment.

- [ ] Run `pnpm test:a11y` on the component gallery. Done when: it passes with no AA violation. Cheaper substitute: spot-checking one page, refused.
- [ ] Measure the report page weight and first render on the live deployment. Done when: the numbers are recorded in the run file and inside the design spec 4.9 targets.
- [ ] Read every demo-path string aloud once and fix what needs a second reading, in `src/web/`. Done when: the sweep record lists the strings changed. Cheaper substitute: a spell-check only, refused.
- [ ] Commit: `launch: final polish sweep`

**Test checkpoint:** `pnpm test:a11y` passes and the sweep record exists.

## 10. Independent validation by an outsider

Operator, 2026-11-02: a person or organisation outside Rizonetech runs the published labelled sets against the live service and publishes their own figures, as the S10 statement (D08 T02 §10) invites. The coordinator prepares everything; the operator only sends the invitation to the outsider they choose (a peer IT firm or industry contact), because no lane can recruit a person. Automated end to end on our side: a validation kit is generated by script, and the outsider's returned figures are imported and shown beside ours, disagreements included.

**Phase:** 6
**Needs:** attended
**Surface:** no

**Build order:**

1. Generate the kit and import the answer. Done when: one command builds the kit and one imports a returned run.

- [ ] Write `scripts/validation-kit.ts`: packs the labelled sets, their licences (`eval/DATASETS.md`), the run instructions and a results template into `build/validation-kit/`. Done when: the command runs and the folder holds all four. Cheaper substitute: a hand-assembled zip, refused.
- [ ] Write the import in `eval/publish.ts`: a returned results file becomes an independent run row shown on `/eval` beside ours, marked with the outsider's name (as they give it) and never merged into our figures. Done when: a fixture return renders beside ours with its disagreements visible.
- [ ] Record the invitation in `todo/findings.md` for the operator: the kit path and the one-line ask. Done when: the line exists; sending it is the operator's single manual act.
- [ ] On return, import and record their figures in `eval/RESULTS.md`. Done when: both figure sets are printed with dates.
- [ ] Commit: `launch: independent validation by an outsider`

**Test checkpoint:** `pnpm exec vitest run test/web/eval-page.test.ts` passes with an independent run fixture, and the kit command produces `build/validation-kit/`.

## 11. Automated demo rehearsal, three clean runs

Operator, 2026-11-02: no manual rehearsal operations. A script walks the §3 demo path against the live service three times unattended, once with a dependency deliberately broken, and records timings and states; a run that shows a placeholder, a raw error or an unexplained wait fails.

**Phase:** 8
**Needs:** cloudflare, meta-api
**Surface:** no

**Build order:**

1. Automate the rehearsal. Done when: `scripts/demo-rehearsal.ts` runs the path three times and fails loudly on any rough edge.

- [ ] Write `scripts/demo-rehearsal.ts`: submits the §3 demo cases to the live service, polls each case to its verdict, and asserts the verdict, cited evidence, the model trace and the spec 4.9 time targets. Done when: a clean live run exits 0 with timings printed. Cheaper substitute: a person clicking through, refused (operator, no manual operations).
- [ ] Add the broken-dependency run: the same script with `--break meta` expects a marked partial report, never a confident verdict. Done when: that run exits 0 only on the partial state.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** `scripts/demo-rehearsal.ts` does not exist and its home needs the D09 T01 §1 ruling. The `--break meta` item presupposes D09 T01 §2's failure hooks, which are unbuilt; §11's Depends On (§3, §8) must add D09 T01 §2 before that item can be built. §8's walk record likewise has no named file: its checkpoint greps `docs/phase-runs/*submission*.md`, which matches nothing today, so the walk item must name its record file.
- [ ] Record three clean runs (dates, timings, verdicts) in `docs/phase-runs/`. Done when: the record exists and any failure files a fix in the owning section.
- [ ] Commit: `launch: automated demo rehearsal`

**Test checkpoint:** `node scripts/demo-rehearsal.ts` exits 0 three times in a row on the live service, recorded.

## 12. Ablation chart for the results and README

Operator, 2026-11-02: the ablation measurement (D08 T02 §3) rendered as one chart, detection with each model removed, on `/eval` and in the README (§6), so the Use of Meta AI criterion is answered by a picture before a judge reads a word.

**Phase:** 8
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S10 Results: model ablation rows and the run history
**Job:** a judge sees in five seconds what each Meta model earns
**Treatment:** one chart, our measured figures only, no model shown that adds nothing without its consequence stated
**Chrome:** the existing public eval page shell and the README, no new surface

**Build order:**

1. Render the chart from measured runs. Done when: the chart reads the published ablation rows, never a hand-typed figure.

- [ ] Add the chart to `src/web/pages/eval-view.tsx` from the same rows the ablation table prints. Done when: removing a row changes the chart. Cheaper substitute: a static image with typed numbers, refused.
- [ ] Export the same chart as `docs/images/ablation-chart.png` through Browser Run for §6. Done when: the image exists and matches the page.
- [ ] Commit: `launch: ablation chart for the results and README`

**Test checkpoint:** `pnpm exec vitest run test/web/eval-page.test.ts` passes with the chart reading its figures from the run rows.

## 13. Judge no-account demo: recorded replay from the repo

Operator information, 2026-11-02, recorded in `docs/hackathon-criteria.md` (Judging access): judges run the project from the public repository's setup instructions and every judging stage needs a working demo, so the video alone is not enough; a judge must never need their own outside account (here: their own Meta Model API keys or Cloudflare account). Today a clean local run stops at the Meta gateway secret, and no replay or mock mode exists. This section gives the repository a no-account path: recorded examples with provenance, replayed through the real pipeline with every simulated part labelled, explained in the README (§6). The hosted live service with judge access (§6, §10) stays the primary demo; this is the path that works from the repo alone.

**Phase:** 8
**Needs:** none
**Surface:** no

**Build order:**

1. Record the examples from published runs, then replay them with labels. Done when: a clean clone with no secrets runs the replay and renders labelled verdicts.

- [ ] Add recorded examples under `eval/judge/` taken from published eval runs (D08 T02 §10): each case a synthetic input, the recorded provider request and response pairs, the verdict and model trace, and provenance (deployed commit, run id, date, model IDs, `store: false`). Done when: every example validates against its schema, names its provenance, and contains synthetic mail only.
- [ ] Add the replay path (`pnpm judge:demo`): the real pipeline served locally with the model transport answering from the recorded pairs, refusing any call with no recorded pair instead of reaching the network. Done when: the replay runs with no Meta or Cloudflare secret in the environment and no network call to a provider.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** none of the named artefacts exist yet (`eval/judge/`, the `judge:demo` script, `test/node/judge-demo.test.ts`), consistent with a section filed today. The transport seam is now named: the Meta client takes an injectable fetch (`ctx.fetch ?? fetch`, `src/meta/client.ts:72`), so the replay answers through that seam and an unrecorded call is refused there, never reaching the network.
- [ ] Label every simulated part where a judge meets it (the replay banner on each rendered page and the README wording): recorded answers read as recorded, never as a live model call. Done when: a rendered replay page carries the label and no page claims a live call.
- [ ] Prove it from a clean clone: a fresh directory, no secrets, following only the README (§6) commands reaches a rendered verdict. Done when: the run is recorded in the section's run file with its commands and output.
- [ ] Commit: `launch: judge no-account demo with recorded replay`

**Test checkpoint:** `pnpm exec vitest run test/node/judge-demo.test.ts` passes (recorded pair required, unrecorded call refused, label rendered), and the clean-clone replay reaches a verdict with no provider secret set.

## Verification

- The repository is ready for judging: README, contributions, notices, results and video assets complete and consistent.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
