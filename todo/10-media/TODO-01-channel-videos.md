---
schema_version: 1
id: media-channel-videos
domain: 10-media
status: active
title: "TODO-01 -- Channel Videos: Development Method and Tech Stack"
track: day-6
---

# TODO-01 -- Channel Videos: Development Method and Tech Stack

> **Goal:** The IsItLegit YouTube channel (@DerickPayneDev) carries two short explainers made in Remotion from the repository: "How IsItLegit is built" (the development method, including the Muse Wonder final review through Muse Code, labelled as tooling) and "IsItLegit in 60 seconds" (the tech stack as an architecture diagram), each with an approved script, a licence basis on file, numbers read from the repository, and a public link recorded here.

> **Current state:** Measured 2026-10-30. `media/` exists on branch `claude/trusting-pasteur-umwvqz` (commits `cc4d49c`, `0b45c62`, `6aed7c0`): its own pnpm root (`media/pnpm-workspace.yaml`, `media/pnpm-lock.yaml`), Remotion 4.0.539 pinned, the brand layer `media/src/brand.tsx` reading `design/` unchanged, the compositions `media/src/videos/HowItIsBuilt.tsx` (65 s) and `media/src/videos/InSixtySeconds.tsx` (60 s), and `media/tools/collect-stats.py` writing the on-screen numbers (278 sections, 95 stamped, 355 rounds, 65 final reviews at `5c92ba8`). Both render to 1920 x 1080 MP4 and were sent to the operator as first drafts; neither script is approved, the Remotion licence basis is not recorded, and nothing is uploaded. The lane is registered but uncoordinated (`docs/specs/2026-10-30-four-lanes-design.md`, Amendment: a fifth lane); its stamps carry the review waiver once D00 T01 §26 ships.

## Inputs

- `media/README.md`: the lane rules (no product feature claims for tooling, numbers from the repository, no Meta Model API calls, licensed music only).
- `media/scripts/01-how-isitlegit-is-built.md` and `media/scripts/02-isitlegit-in-60-seconds.md`: the scene-by-scene scripts the operator approves.
- `design/brand/README.md`, `design/tokens/colors.json`, `design/fonts/`: brand files used unchanged.
- `README.md` "How it uses Meta's models" and "How it is built", `docs/specs/2026-10-26-tech-stack-design.md`: the facts in video 02.
- `.conclave/reviewers.toml` and `docs/reviews/`: the review method and the receipts video 01 shows.
- `CONTRIBUTIONS.md`: declares the review tooling as pre-existing development tooling (coordinator, `b223a08`).
- `docs/hackathon-criteria.md`: rights to everything used; tooling never shown as a product feature.
- Not this file: the demo video's Remotion assets are D09 T02 §4 and its recording and upload are D99 T02 §3 to §5. The waived stamp is D00 T01 §26.

## Outcome

- Both videos are public on @DerickPayneDev, play logged out, and their links are recorded here.
- Every number on screen matches `media/tools/collect-stats.py` run on the rendered commit, which the closing frame names.
- The Remotion licence basis for Rizonetech is recorded here before the final renders.

**Adjacency:** all=not-applicable (marketing videos outside the product; they create no product records)

**Adjacency rationale:** The videos are channel content rendered from repository facts. They hold no user data, no settings and no lifecycle; a wrong video is replaced by a new upload, recorded here.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Media package and stats collector | -- | [ ] |
| 2 | §2 | Remotion licence basis | -- | [ ] |
| 3 | §3 | Video 01: development method | §1, §2 | [ ] |
| 4 | §4 | Video 02: tech stack | §1, §2 | [ ] |
| 5 | §5 | Uploads and links recorded | §3, §4 | [ ] |

## 1. Media package and stats collector

The self-contained Remotion package every video renders from: its own pnpm root so the root workspace and lockfile are never touched (coordinator, D10 step 5), a brand layer that reads `design/` unchanged, and a collector that reads every on-screen number from the repository so no number is typed in.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Create the package in `media/` as its own pnpm root. Done when: `pnpm install --frozen-lockfile` in `media/` leaves the root `pnpm-lock.yaml` unchanged.
2. Read the numbers in `media/tools/collect-stats.py` and prove the counting with a test. Done when: the test fails if the row or receipt patterns are broken.

- [x] Create `media/package.json`, `media/pnpm-workspace.yaml` and `media/pnpm-lock.yaml` with `remotion` and `@remotion/cli` pinned to 4.0.539 (stack doc pin, D09 T02 §4). Done when: `pnpm install --frozen-lockfile` in `media/` succeeds and `git status` shows no change to the root lockfile. Cheaper substitute: adding `media` to the root `pnpm-workspace.yaml` fails the root-lockfile check. (`6aed7c0`)
- [x] Serve `design/` as the public folder in `media/remotion.config.ts`. Done when: `staticFile("brand/logo-svg/isitlegit-logo.svg")` renders the logo in a still. Cheaper substitute: copying brand files into `media/` fails, since they would drift from `design/`. (`0b45c62`)
- [x] Load Exo and Exo 2 from `design/fonts/` and expose the light theme tokens in `media/src/brand.tsx` (`design/brand/README.md` "Type", `design/tokens/colors.json`). Done when: a still shows Exo 2 body text, not a serif fallback. Cheaper substitute: hard-coded hex values fail when a token changes. (`0b45c62`)
- [x] Write `media/tools/collect-stats.py` to count Implementation Order rows, stamped rows, `## Round` and non-`none` `## Final review` headings, and HEAD's date and short SHA, written atomically to `media/src/data/stats.json`. Done when: it prints the JSON and the file is replaced, never half-written. Cheaper substitute: numbers typed into a scene fail the moment a section ships. (`0b45c62`)
- [x] Add `media/tools/test_collect_stats.py` (unittest) that builds a temporary tree with two rows (one `[x]`), one `## Round 1`, one `## Final review: wonder` and one `## Final review: none`, and asserts `sections=2, stamped=1, rounds=1, finals=1`. Done when: `python3 -m unittest discover -s media/tools` passes and fails when `FINAL` stops excluding `none`. (`8f7df4f3`)
- [x] Let `collect-stats.py` take the repository root as an optional argument for the test. Done when: the test runs without touching the real tree. Cheaper substitute: a test that reads the live repository fails as soon as a section ships. (`8f7df4f3`)
- [x] Commit: `media: test the stats collector` (`8f7df4f3`)

**Test checkpoint:** `python3 -m unittest discover -s media/tools` passes, and `cd media && pnpm install --frozen-lockfile && pnpm exec tsc -p .` exits 0.

## 2. Remotion licence basis

Remotion is free for individuals and for companies of up to three people; a larger company needs a paid company licence (coordinator caution, 2026-10-30). The hackathon requires rights to everything used (`docs/hackathon-criteria.md`). Rizonetech's headcount decides which applies, and only the operator knows it. Phase 6, not 99, because the renders in §3 and §4 wait on it.

**Phase:** 6
**Needs:** operator
**Surface:** no

**Build order:**

1. The operator confirms which Remotion licence covers Rizonetech. Done when: one line records it here.

- [ ] Operator: check Rizonetech's headcount against the Remotion licence terms at `https://www.remotion.dev/license` and buy a company licence if over three people. Done when: the operator states which licence applies.
- [ ] Record the line `Remotion licence: <free (up to 3 people) | company licence, <reference>>, confirmed YYYY-MM-DD` under this section. Done when: the line is written. Cheaper substitute: assuming the free tier from the hackathon team size fails, since the licence counts the company.
- [ ] Commit: `todo: record the Remotion licence basis (D10 T01 §2)`

**Test checkpoint:** `grep -cE '^Remotion licence: ' todo/10-media/TODO-01-channel-videos.md` prints `1`.

## 3. Video 01: development method

The development method in about 65 seconds: the plan as small sections, Claude Code building, GPT-6 Astra's rounds, the one Muse Wonder final review through Muse Code, the stamp and its receipt, and live counts. Every scene carries the label "Our development process, not a product feature" (`docs/hackathon-criteria.md`, identify contributions).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. The operator approves `media/scripts/01-how-isitlegit-is-built.md`. Done when: its approval line is written.
2. Match `media/src/videos/HowItIsBuilt.tsx` to the approved script and render it. Done when: `media/out/01-how-isitlegit-is-built.mp4` is 1920 x 1080 and its duration equals the script's total.

- [ ] Operator: answer the script's open questions (voiceover or text only; reviewer names or roles). Done when: the answers are written into `media/scripts/01-how-isitlegit-is-built.md`.
- [ ] Record `Script approved: 01, YYYY-MM-DD` in `media/scripts/01-how-isitlegit-is-built.md`. Done when: the line is written.
- [ ] Apply the approved wording and timings to `SCENES` and the scene components in `media/src/videos/HowItIsBuilt.tsx`. Done when: every on-screen line matches the script. Cheaper substitute: rendering the draft unchanged fails if the operator changed any line.
- [ ] Keep the quoted Muse finding in `FINDING` identical to `docs/reviews/01-intake/D01-T01-s2.md` line 139. Done when: `grep -F` of the quoted clause finds it in the receipt.
- [ ] Render with `pnpm render:01` in `media/` on a committed tree. Done when: the closing frame names a commit that `git cat-file -e` accepts.
- [ ] Check stills of every scene for fonts, safe margins and the tooling label. Done when: each scene's still shows Exo, the label and nothing cut off.
- [ ] Commit: `media: video 01 approved and rendered (D10 T01 §3)`

**Test checkpoint:** `ffprobe -v error -show_entries stream=width,height:format=duration -of csv=p=0 media/out/01-how-isitlegit-is-built.mp4` prints `1920,1080` and the script's total in seconds, and `grep -c '^Script approved: 01, ' media/scripts/01-how-isitlegit-is-built.md` prints `1`.

## 4. Video 02: tech stack

One suspicious email followed through the system as a labelled architecture diagram: intake, the Worker's Workflows steps, each Meta model's one job through AI Gateway, evidence storage, and the verdict marks from `design/brand/motion/`. It shows no product screens, so it never stands in for the live demo (`docs/hackathon-criteria.md`, Demo).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. The operator approves `media/scripts/02-isitlegit-in-60-seconds.md`. Done when: its approval line is written.
2. Match `media/src/videos/InSixtySeconds.tsx` to the approved script and render it. Done when: `media/out/02-isitlegit-in-60-seconds.mp4` is 1920 x 1080 and 60 seconds.

- [ ] Operator: answer the script's open questions (include Muse Image or not; voiceover or text only). Done when: the answers are written into `media/scripts/02-isitlegit-in-60-seconds.md`.
- [ ] Record `Script approved: 02, YYYY-MM-DD` in `media/scripts/02-isitlegit-in-60-seconds.md`. Done when: the line is written.
- [ ] Check each model role in `MODELS` in `media/src/videos/InSixtySeconds.tsx` against `README.md` "How it uses Meta's models". Done when: every role matches the README's wording in meaning. Cheaper substitute: a role the product does not have fails the hackathon's no-mocks rule.
- [ ] Apply the approved wording and timings to `SCENES` and the scene components. Done when: every on-screen line matches the script.
- [ ] Render with `pnpm render:02` in `media/` on a committed tree. Done when: the file exists at 1920 x 1080.
- [ ] Check stills of every scene for fonts, safe margins and the "Architecture diagram" label. Done when: each scene's still shows them.
- [ ] Commit: `media: video 02 approved and rendered (D10 T01 §4)`

**Test checkpoint:** `ffprobe -v error -show_entries stream=width,height:format=duration -of csv=p=0 media/out/02-isitlegit-in-60-seconds.mp4` prints `1920,1080` and `60.000000`, and `grep -c '^Script approved: 02, ' media/scripts/02-isitlegit-in-60-seconds.md` prints `1`.

## 5. Uploads and links recorded

The operator uploads the two approved renders to @DerickPayneDev as public videos in an `IsItLegit` playlist, with the titles and descriptions from the scripts, and checks each one logged out.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Upload both and record the links. Done when: two `Video 0N:` lines are written here and both play logged out.

- [ ] Operator: upload `media/out/01-how-isitlegit-is-built.mp4` as public, in the `IsItLegit` playlist. Done when: it plays in a logged-out window at 1080p.
- [ ] Operator: upload `media/out/02-isitlegit-in-60-seconds.mp4` the same way. Done when: it plays logged out at 1080p.
- [ ] Record `Video 01: https://www.youtube.com/watch?v=<id>` and `Video 02: https://www.youtube.com/watch?v=<id>` under this section. Done when: both lines are written.
- [ ] Add both links to the Videos table in `media/README.md`. Done when: each row links its video.
- [ ] Commit: `todo: record the channel video links (D10 T01 §5)`

**Test checkpoint:** `grep -cE '^Video 0[12]: https://www\.youtube\.com/watch\?v=' todo/10-media/TODO-01-channel-videos.md` prints `2`.

## Verification

- Both links play logged out, and each video's closing frame names a commit whose `media/tools/collect-stats.py` output matches the numbers shown.
- `python3 -m unittest discover -s media/tools` passes.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
