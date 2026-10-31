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

## 1. CONTRIBUTIONS.md by day, commit ranges

**Corrected 2026-10-28:** the title read "CONTRIBUTIONS.md by day with commit ranges"; shortened by a word so the Phase 6 plan table stays within 100 characters once 11-character references (D01 T01 §10, D05 T04 §10) joined it.

The rule "identify your contributions" (`docs/hackathon-criteria.md`): what was built each day with its commit range, the pre-existing development tooling declared separately, and third-party code and data listed with licences.

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

## Verification

- The repository is ready for judging: README, contributions, notices, results and video assets complete and consistent.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
