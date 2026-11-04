---
schema_version: 1
id: media-channel-videos
domain: 10-media
status: active
title: "TODO-01 -- Channel Videos: Development Process and Technical Deep Dive"
track: day-6
---

# TODO-01 -- Channel Videos: Development Process and Technical Deep Dive

> **Goal:** The IsItLegit YouTube channel (@DerickPayneDev) carries three explainers made in Remotion from the repository: "How IsItLegit is built" (the development process in long form, including the lanes, the coordinator and the Muse Wonder final review, labelled as tooling), "IsItLegit: how it works" (the technical deep dive in long form, with an honest shipped or planned mark per chapter) and "Loupe 1.0" (a technical deep dive on the page screener, figures pinned to the glimmer lane), each with an approved script, a licence basis on file, numbers read from the repository, and a public link recorded here.

> **Current state:** Measured 2026-10-30. `media/` exists on branch `claude/trusting-pasteur-umwvqz` (commits `cc4d49c`, `0b45c62`, `6aed7c0`): its own pnpm root (`media/pnpm-workspace.yaml`, `media/pnpm-lock.yaml`), Remotion 4.0.539 pinned, the brand layer `media/src/brand.tsx` reading `design/` unchanged, videos 01 and 02 as long-form storyboards (`media/data/storyboards/`) rendered by the scene kit `media/src/kit/` after the operator asked for 5 to 10 minute learning videos (2026-10-30), replacing the 65 s and 60 s drafts, with figures from `media/tools/collect-stats.py` (git pace, per-domain stamps, review counts) and from `media/data/dev-facts.json` and `media/data/tech-facts.json`, every quote proven by `media/tools/check-facts.py`. Both render to 1920 x 1080 MP4; neither script is approved, the Remotion licence basis is not recorded, and nothing is uploaded. The lane is registered but uncoordinated (`docs/specs/2026-10-30-four-lanes-design.md`, Amendment: a fifth lane); its stamps carry the review waiver once D00 T01 §26 ships.

## Inputs

- `media/README.md`: the lane rules (no product feature claims for tooling, numbers from the repository, no Meta Model API calls, licensed music only).
- `media/scripts/01-how-isitlegit-is-built.md` and `media/scripts/02-isitlegit-technical-deep-dive.md`: the chapter outlines the operator approves; the words are the storyboards in `media/data/storyboards/`.
- `design/brand/README.md`, `design/tokens/colors.json`, `design/fonts/`: brand files used unchanged.
- `README.md` "How it uses Meta's models" and "How it is built", `docs/specs/2026-10-26-tech-stack-design.md`: the facts in video 02.
- `.conclave/reviewers.toml` and `docs/reviews/`: the review method and the receipts video 01 shows.
- `CONTRIBUTIONS.md`: declares the review tooling as pre-existing development tooling (coordinator, `b223a08`).
- `docs/hackathon-criteria.md`: rights to everything used; tooling never shown as a product feature.
- Not this file: the demo video's Remotion assets are D09 T02 §4 and its recording and upload are D99 T02 §3 to §5. The waived stamp is D00 T01 §26.

## Outcome

- All three videos are public on @DerickPayneDev, play logged out, and their links are recorded here.
- Every number on screen matches `media/tools/collect-stats.py` run on the rendered commit, which the closing frame names.
- The Remotion licence basis for Rizonetech is recorded here before the final renders.

**Adjacency:** all=not-applicable (marketing videos outside the product; they create no product records)

**Adjacency rationale:** The videos are channel content rendered from repository facts. They hold no user data, no settings and no lifecycle; a wrong video is replaced by a new upload, recorded here.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Media package and stats collector | -- | [x] |
| 2 | §2 | Remotion licence basis | -- | [x] |
| 3 | §3 | Video 01: development process, long form | §1, §2 | [ ] |
| 4 | §4 | Video 02: technical deep dive, long form | §1, §2 | [ ] |
| 5 | §5 | Uploads and links recorded | §3, §4 | [ ] |
| 6 | §6 | Video 03: Loupe 1.0 technical deep dive | §1, §2 | [ ] |
| 7 | §7 | Video 03 upload and link recorded | §6 | [ ] |
| 8 | §8 | Video 04: judge getting-started guide | §1, §2 | [ ] |
| 9 | §9 | X 45-second viral teaser clip | §1, §2 | [ ] |
| 10 | §10 | YouTube channel banner (@DerickPayneDev) | §1, §2 | [ ] |
| 11 | §11 | Videos re-cut as the live gaps close | §8, §9 | [ ] |
| 12 | §12 | P3 review leftovers from the media stamps | -- | [ ] |

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

**Test checkpoint:** `python3 -m unittest discover -s media/tools` passes, and `cd media && pnpm install --frozen-lockfile && pnpm run stats && pnpm run voice && pnpm run capture:index && pnpm exec tsc -p . && pnpm test:kit && pnpm preflight` exits 0 on a clean checkout (the compositions import three generated, git-ignored modules, `src/data/stats.json`, `src/data/voice.ts` and `src/data/demo-capture.ts`, so the three generators run before the type check, as they do before every render and the studio).

> **Verified:** 2026-11-04 | §1 | 35be5447b7a8bd3fed66bc39937f3bfd01d85873
> **Review:** `docs/reviews/d10-t01-s1.json`

## 2. Remotion licence basis

Remotion is free for individuals and for companies of up to three people; a larger company needs a paid company licence (coordinator caution, 2026-10-30). The hackathon requires rights to everything used (`docs/hackathon-criteria.md`). Rizonetech's headcount decides which applies, and only the operator knows it. Phase 6, not 99, because the renders in §3 and §4 wait on it.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. The operator confirms which Remotion licence covers Rizonetech. Done when: one line records it here.

- [x] Operator: check Rizonetech's headcount against the Remotion licence terms at `https://www.remotion.dev/license` and buy a company licence if over three people. Done when: the operator states which licence applies.
- [x] Record the line `Remotion licence: <free (up to 3 people) | company licence, <reference>>, confirmed YYYY-MM-DD` under this section. Done when: the line is written. Cheaper substitute: assuming the free tier from the hackathon team size fails, since the licence counts the company.
- [x] Commit: `todo: record the Remotion licence basis (D10 T01 §2)`

**Test checkpoint:** `grep -cE '^Remotion licence: (free \(up to 3 people\)|company licence, [A-Z0-9][A-Z0-9-]{5,}), .*confirmed 20[0-9]{2}-[0-9]{2}-[0-9]{2}$' todo/10-media/TODO-01-channel-videos.md` prints `1` (a placeholder, an undated line, or a company licence whose reference is not an order number of six or more capitals and digits, such as `<reference>` or `pending`, prints `0`), and `grep -c 'Remotion 4.0.539' media/README.md` prints `1` (the licence basis carried into the media folder's Licences list).

Remotion licence: free (up to 3 people), Rizonetech has 3 people, confirmed 2026-10-30

> **Verified:** 2026-11-04 | §2 | 158ee45694c372196945b741366c201758bda593
> **Review:** `docs/reviews/d10-t01-s2.json`

## 3. Video 01: development process, long form

The development process in about 11 and a half minutes, for learning and for the channel: the governing documents, the plan as a graph, the section contract, the five lanes as a team, the coordinator as team lead, the loop that runs around the clock (with commits by hour and by day from git), independent review with the Muse Wonder final review, the stamp and its receipt, the guards, and how it adds up to speed. Every scene carries the label "Our development process, not a product feature" (`docs/hackathon-criteria.md`, identify contributions). Long form on the operator's request, 2026-10-30.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write `media/data/storyboards/01-development-process.json` with every figure named from `media/data/dev-facts.json` or the collector. Done when: `pnpm check:facts` passes.
2. The operator approves `media/scripts/01-how-isitlegit-is-built.md`, then the final render. Done when: its approval line is written and `media/out/01-how-isitlegit-is-built.mp4` is 1920 x 1080.

- [x] Pin the process facts in `media/data/dev-facts.json` (50 facts, quotes from `AGENTS.md`, `docs/specs/2026-10-30-four-lanes-design.md`, `.conclave/reviewers.toml`, `todo/README.md`, `scripts/`), with no writer model identifier, client data or account names. Done when: `python3 media/tools/check-facts.py` passes. Cheaper substitute: typed figures fail the lane rule.
- [x] Add commits and stamps per day, commits per hour of day across every lane, merges, per-domain stamps and lines of code to `media/tools/collect-stats.py`, leaving out the template rows, with tests. Done when: its sections total equals `scripts/todo-graph.py validate`'s count.
- [x] Write the storyboard and register it in `media/src/Root.tsx` as `DevProcess`. Done when: stills of all 33 content scenes show the label, Exo fonts and nothing cut off.
- [x] Operator: answer the script's open questions (voiceover or text only; reviewer names). Done when: the answers are written into `media/scripts/01-how-isitlegit-is-built.md`.
- [x] Record `Script approved: 01, YYYY-MM-DD` in `media/scripts/01-how-isitlegit-is-built.md`. Done when: the line is written.
- [x] Re-pin `media/data/dev-facts.json` to the commit of the final render and re-render with `pnpm render:01` on a committed tree. Done when: the closing frame names a commit that `git cat-file -e` accepts. Cheaper substitute: rendering at an old pin shows stale counts.
- [x] Commit: `media: video 01 approved and rendered (D10 T01 §3)`

**Test checkpoint:** `python3 media/tools/check-facts.py` exits 0, `ffprobe -v error -show_entries stream=width,height -of csv=p=0 media/out/01-how-isitlegit-is-built.mp4` prints `1920,1080`, and `grep -c '^Script approved: 01, ' media/scripts/01-how-isitlegit-is-built.md` prints `1`.

## 4. Video 02: technical deep dive, long form

The product's technical specification in about 11 minutes: intake, uploads and voice, the Workflows pipeline, the evidence model and checks, reputation and the hard floor, link following with Muse Wonder, vision, the Meta model client and AI Gateway, the verdict agent, invoices, the trust network, storage and retention, the app, evaluation and the pinned stack. Every chapter card says shipped, partly built or planned, measured from `src/` and the stamped plan, and diagrams are never product screens, so it never stands in for the live demo (`docs/hackathon-criteria.md`, Demo). Replaces the 60-second tech stack draft on the operator's request, 2026-10-30.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write `media/data/storyboards/02-technical-deep-dive.json` with every figure named from `media/data/tech-facts.json`. Done when: `pnpm check:facts` passes.
2. The operator approves `media/scripts/02-isitlegit-technical-deep-dive.md`, then the final render. Done when: its approval line is written and `media/out/02-isitlegit-technical-deep-dive.mp4` is 1920 x 1080.

- [x] Pin the product facts in `media/data/tech-facts.json` (92 facts, status `shipped` only for code in `src/` at the pin, `planned` for the design spec), with no client data, keys or account IDs. Done when: `python3 media/tools/check-facts.py` passes. Cheaper substitute: calling a designed feature shipped fails the no-mocks rule.
- [x] Write the storyboard and register it in `media/src/Root.tsx` as `TechDeepDive`. Done when: stills of all 25 content scenes show the label and nothing cut off, including the wrapped code lines.
- [x] Operator: answer the script's open questions (voiceover; a re-render once the verdict agent ships). Done when: the answers are written into `media/scripts/02-isitlegit-technical-deep-dive.md`.
- [x] Record `Script approved: 02, YYYY-MM-DD` in `media/scripts/02-isitlegit-technical-deep-dive.md`. Done when: the line is written.
- [x] Re-check every chapter's shipped, partly built or planned mark against `src/` and the stamped rows at the final render's commit, and upgrade the composition to the Demo standard: embed the Meta infinity SVG mark in `MetaBadge` (`media/src/brand.tsx`), the two-row Runtime Meta AI + `Built with Meta Muse Code (Wonder 1.0)` & full-stack badge strip, the live Playwright product captures, the abstract animated background (`GENERATED.loop` / plates), the live `/eval` ablation chart, and the 5 Remotion Meta Model "How It's Done" X-Ray overlays (`muse-spark-1.3` untrusted fence and floor, `sam-3.1` segmentation mask crop, `muse-wonder-1.0` containment HUD and canary, `Loupe 1.1 -> Muse Spark` cascade, and `WASM Opus -> muse-voice-transcribe-1.0` pipeline). Done when: each mark matches and the upgraded scenes render. Cheaper substitute: keeping the 30 Oct static slides and `planned` marks fails once the product ships.
- [x] Re-pin and re-render with `pnpm render:02` on a committed tree. Done when: the file exists at 1920 x 1080.
- [x] Commit: `media: video 02 approved and rendered (D10 T01 §4)`

**Test checkpoint:** `python3 media/tools/check-facts.py` exits 0, `ffprobe -v error -show_entries stream=width,height -of csv=p=0 media/out/02-isitlegit-technical-deep-dive.mp4` prints `1920,1080`, and `grep -c '^Script approved: 02, ' media/scripts/02-isitlegit-technical-deep-dive.md` prints `1`.

## 5. Uploads and links recorded

The operator uploads the two approved renders to @DerickPayneDev as public videos in an `IsItLegit` playlist, with the titles and descriptions from the scripts, and checks each one logged out.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Upload both and record the links. Done when: two `Video 0N:` lines are written here and both play logged out.

- [ ] Operator: upload `media/out/01-how-isitlegit-is-built.mp4` as public, in the `IsItLegit` playlist. Done when: it plays in a logged-out window at 1080p.
- [ ] Operator: upload `media/out/02-isitlegit-technical-deep-dive.mp4` the same way. Done when: it plays logged out at 1080p.
- [ ] Record `Video 01: https://www.youtube.com/watch?v=<id>` and `Video 02: https://www.youtube.com/watch?v=<id>` under this section. Done when: both lines are written.
- [ ] Add both links to the Videos table in `media/README.md`. Done when: each row links its video.
- [ ] Commit: `todo: record the channel video links (D10 T01 §5)`

**Test checkpoint:** `grep -cE '^Video 0[12]: https://www\.youtube\.com/watch\?v=' todo/10-media/TODO-01-channel-videos.md` prints `2`.

## 6. Video 03: Loupe 1.0 technical deep dive

A 132-second technical video on Loupe, the page screener of D03 T04: the job behind `screenPage`, the Muse Glimmer 30B base model, the seven licensed sources and the benign renders, the 129,892-page collection, the Muse Spark teacher and its 61 percent bar, the split and its leakage controls, the two refused builds, the LoRA recipe, the promotion gate and the serving plan. Loupe 1.0 is not trained yet (measured 2026-10-30 at glimmer `3be0168e`), so every scene says so, planned values are tagged, and no result is claimed. Requested by the operator 2026-10-30 for technical depth.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Pin every figure in `media/data/loupe-facts.json` to the glimmer commit with a quote or a counted pattern, proven by `media/tools/check-facts.py`. Done when: `pnpm check:facts` passes and fails on a changed figure.
2. Build `media/src/videos/LoupeV1.tsx` from `media/scripts/03-loupe-1-0.md` and render it. Done when: `media/out/03-loupe-1-0.mp4` is 1920 x 1080 and 132 seconds.

- [x] Write `media/data/loupe-facts.json`: 52 facts, each `measured` or `planned`, pinned to `3be0168e0ffc03d72534ba756bf534a1ed72eca9`, with no client content, account names, keys, store paths or budgets (sources: `docs/glimmer/training.md`, `docs/glimmer/sources.md`, `docs/phase-runs/2026-10-30-glimmer-phase-0.md`, `todo/03-vision/TODO-04-glimmer.md`, `scripts/glimmer/`). Done when: `python3 media/tools/check-facts.py` prints `52 facts hold`. Cheaper substitute: figures typed into the scenes fail the lane rule that every number has a source.
- [x] Write `media/tools/check-facts.py` (quote and count facts) and `media/tools/test_check_facts.py`. Done when: the six tests pass, and changing a value, a quote, a count, a source or a status fails.
- [x] Write `media/scripts/03-loupe-1-0.md` with 13 scenes, the "not shown, on purpose" list and the open questions. Done when: the script names every scene's figures and their source file.
- [x] Build `media/src/videos/LoupeV1.tsx` and register `LoupeV1` in `media/src/Root.tsx`, with the status label on every scene and a `planned` tag on the recipe, gate, serving and `screenPage` lines. Done when: `pnpm exec tsc -p .` exits 0 and stills of all 13 scenes show the label.
- [x] Add `render:03` (after `check:facts`) to `media/package.json`. Done when: `pnpm render:03` writes `media/out/03-loupe-1-0.mp4` at 1920 x 1080, 132 s.
- [x] Operator: answer the script's open questions (teacher spend, the 61 percent bar, voiceover, a results re-render). Done when: the answers are written into `media/scripts/03-loupe-1-0.md`.
- [x] Record `Script approved: 03, YYYY-MM-DD` in `media/scripts/03-loupe-1-0.md`. Done when: the line is written.
- [x] Re-pin `commit` and refresh `media/data/loupe-facts.json` and `media/src/videos/LoupeV1.tsx` to the Demo standard across the three-stage Loupe 1.1 schedule (D03 T04 §47 / §50) while keeping the 3-minute Demo Video (`Demo.tsx`) completely decoupled from late-night metric decimals so `Demo.tsx` is locked by `18:00 SAST` and never re-rendered at night: (a) after the `08:00 SAST` / `14:00 SAST` Wed 4 Nov Checkpoint #1/#2 promotions, pin the verified metrics so all daytime renders and the `18:00 SAST` submission complete with zero blocking; (b) write `Video 03`'s narration in `media/scripts/03-loupe-1-0.md` so the spoken voiceover states the structural 1.1 story while the on-screen cards display the exact pinned numbers from `media/data/loupe-facts.json` (requiring zero ElevenLabs voiceover regeneration when numbers update); and (c) immediately after the 100%-completed Loupe 1.1 training finishes and promotes (`~21:00 to 23:30 SAST` Wed 4 Nov, completed before `00:00 SAST`), run the fast ~10-minute final stats update in `media/data/loupe-facts.json` (`python3 media/tools/check-facts.py`) and re-render only `LoupeV1.tsx` (`pnpm render:03`): replace the Oct 30 `planned` tags with the measured Loupe 1.0 training results (`52,019` lines, `14 h 29 min`, `0.980` recall, `0.057` false alarms, `3.9 s` median latency), the honest weak-spot diagnosis (`0.635` lure-type accuracy), the final 100%-trained Loupe 1.1 results (`172,987` frozen pages, `Loupe -> Muse Spark` confidence escalation from D03 T04 §48, prompt-injection robustness, and the open-weight LoRA adapter at `huggingface.co/rizonetech/isitlegit-loupe`), plus live captures of `#model-trace` and `/eval`, the Meta-logo `MetaBadge` and `Built with Meta Muse Code (Wonder 1.0)` & full-stack badge strip, the Remotion X-Ray cascade overlay, and the abstract animated background (`GENERATED.loop`). Done when: `pnpm check:facts` and `pnpm render:03` pass at the final 100%-trained commit before `00:00 SAST`. Cheaper substitute: rendering at the old Oct 30 pin or requiring a `Demo.tsx` or voiceover re-render after `18:00 SAST`.
- [x] Render the final cut with `pnpm render:03` on a committed tree. Done when: the file exists at 1920 x 1080.
- [x] Commit: `media: video 03 approved and rendered (D10 T01 §6)`

**Test checkpoint:** `python3 -m unittest discover -s media/tools` passes, `python3 media/tools/check-facts.py` exits 0, and `ffprobe -v error -show_entries stream=width,height -of csv=p=0 media/out/03-loupe-1-0.mp4` prints `1920,1080`, and `grep -c '^Script approved: 03, ' media/scripts/03-loupe-1-0.md` prints `1`.

## 7. Video 03 upload and link recorded

The operator uploads the approved video 03 to @DerickPayneDev as public, in the `IsItLegit` playlist, and checks it logged out.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Upload and record the link. Done when: a `Video 03:` line is written here and the video plays logged out.

- [ ] Operator: upload `media/out/03-loupe-1-0.mp4` as public, in the `IsItLegit` playlist (ordered: 1. 3-Minute Live Demo, 2. Judge Getting-Started Guide, 3. Video 03 Loupe Deep Dive, 4. Video 02 Technical Deep Dive, 5. Video 01 How IsItLegit Was Built, 6. Extended Demo Cut if time permits). Done when: it plays in a logged-out window at 1080p.
- [ ] Record `Video 03: https://www.youtube.com/watch?v=<id>` under this section. Done when: the line is written.
- [ ] Add the link to the Videos table in `media/README.md`. Done when: the row links its video.
- [ ] Commit: `todo: record the video 03 link (D10 T01 §7)`

**Test checkpoint:** `grep -cE '^Video 03: https://www\.youtube\.com/watch\?v=' todo/10-media/TODO-01-channel-videos.md` prints `1`.

## 8. Video 04: judge getting-started guide

**Corrected 2026-11-04 (operator review):** the guide covers the live web path only. `pnpm judge:demo` is not on main (D09 T02 §13 is open), so the video no longer shows or names it, and the Hugging Face link is dropped while the repository answers 401. The X-ray overlays are removed from every video: they covered the product and showed figures the service cannot back. Renders now go to `media/out2/` (git-ignored).

A 60 to 90 second Judge Getting-Started walkthrough video rendered in Remotion (`media/out/04-judge-getting-started.mp4`) and embedded at the top of `README.md` and #2 in the `IsItLegit` YouTube playlist, walking judges through both zero-friction paths: (1) the 60-second live web path (`isitlegit.co.za` / `app.isitlegit.co.za` with the pre-populated Fynbos Freight demo org, forwarding/uploading an email, invoice or voice note, opening `?trace=1` `#model-trace` to inspect `muse-spark-1.3`, `muse-wonder-1.0`, `sam-3.1`, `Loupe`, and `muse-voice-transcribe-1.0`, and checking `/eval` and `huggingface.co/rizonetech/isitlegit-loupe`), and (2) the zero-account local replay path (`pnpm judge:demo`, answering Yash Khare's 2026-11-03 guidance with recorded pairs and clear provenance labels).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Build and render `media/out/04-judge-getting-started.mp4` at 1920 x 1080 (60 to 90 s). Done when: the MP4 renders and covers both the live web quickstart and `pnpm judge:demo`.

- [x] Build the Judge Getting-Started Remotion composition in `media/src/videos/` combining live Playwright captures of `isitlegit.co.za` (`?trace=1`, `/eval`, Hugging Face) and the `pnpm judge:demo` local replay terminal and browser view, with Brian's voiceover and the abstract animated background. Done when: `cd media && pnpm render:04` writes `media/out/04-judge-getting-started.mp4`.
- [x] Commit: `media: judge getting-started video (D10 T01 §8)`

**Test checkpoint:** `ffprobe -v error -show_entries stream=width,height -of csv=p=0 media/out/04-judge-getting-started.mp4` prints `1920,1080`.

## 9. X 45-second viral teaser clip

A punchy 45-second native video teaser (`media/out/x-teaser-45s.mp4`, 1920 x 1080) cut from Scene 3's live product investigation and Remotion Meta Model "How It's Done" X-Ray overlays (`sam-3.1` logo crop, `muse-wonder-1.0` contained browser walkthrough with canary credentials, `Loupe 1.1 -> Muse Spark` bank-change verdict, and `#model-trace`) for the US$20,000 Most Viral Project on X post tagging `@AIMetaDevs` (D99 T02 §8).

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Render the 45-second native X teaser clip. Done when: `media/out/x-teaser-45s.mp4` exists at 1920 x 1080 and is 45 seconds or shorter.

- [x] Add an `XTeaser` Remotion composition (`45 s`) highlighting the forward-to-verdict flow and all 5 Meta Model X-Ray overlays, and render to `media/out/x-teaser-45s.mp4`. Done when: the file renders cleanly.
- [x] Commit: `media: 45-second X viral teaser clip (D10 T01 §9)`

**Test checkpoint:** `ffprobe -v error -show_entries stream=width,height -of csv=p=0 media/out/x-teaser-45s.mp4` prints `1920,1080`.

## 10. YouTube channel banner (@DerickPayneDev)

A personal developer YouTube channel banner (`2560 x 1440` PNG with all key typography and branding inside the `1546 x 423` centred TV/desktop/mobile safe zone) for `@DerickPayneDev`, unrelated to IsItLegit (branded around Derick Payne, AI Engineering, Systems Architecture and Production Builds) so the channel header is permanent and professional.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Render `media/out/youtube-banner-derickpaynedev.png` at 2560 x 1440. Done when: the PNG exists and passes the safe-zone dimensions check.

- [x] Build a `ChannelBanner` still composition in `media/src/videos/` at `2560 x 1440` (`1546 x 423` safe area) for `@DerickPayneDev` (unrelated to IsItLegit) and render to `media/out/youtube-banner-derickpaynedev.png`. Done when: the file exists at `2560 x 1440`.
- [x] Commit: `media: @DerickPayneDev YouTube channel banner (D10 T01 §10)`

**Test checkpoint:** `ffprobe -v error -show_entries stream=width,height -of csv=p=0 media/out/youtube-banner-derickpaynedev.png` prints `2560,1440`.

## 11. Videos re-cut as the live gaps close

The 2026-11-04 rebuild left four things out of the demo, the judge guide and the teaser because the live service could not back them (operator review): the public verify page renders with no styling, the website seal page answers 404, the report's model-trace panel (`?trace=1`) does not show in the capture, and the Loupe adapter on Hugging Face is not public. Each joins the videos the day it works, through a capture beat and a scene, never a board or a mock. The fixes themselves belong to other lanes and are asked for through the coordinator (outbox, 2026-11-04).

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Re-check each gap against the live service before every re-render. Done when: each item below records `live` or `still missing` with the date.
2. Capture and cut in each gap that is live. Done when: the re-rendered files in `media/out2/` show it, and `docs/demo-script.md` names it.

- [ ] Verify page: when `https://isitlegit.co.za/v/fynbos-freight` renders with its stylesheet, add it to the trust scene of `media/src/videos/Demo.tsx` from the `verify` beat in `media/capture/beats.ts` (already captured). Done when: a still of the scene shows the styled page. Cheaper substitute: showing the board `design/mockups/png/Verify-Protected.png` fails the no-mocks rule.
- [ ] Website seal: when `https://app.isitlegit.co.za/s/fynbos-freight` answers 200, add a `seal` beat to `media/capture/beats.ts` and its shot to the trust scene. Done when: the capture manifest lists `seal` and the scene shows it.
- [ ] Model trace: when `#model-trace` shows on `/r/:id?trace=1`, cut the trace view (`traceShown` to `traceDone` in the `upload-and-report` beat) into the report scene with the models it lists named in the window's title bar. Done when: a still shows the panel with real model calls.
- [ ] Loupe on Hugging Face: when `https://huggingface.co/rizonetech/isitlegit-loupe` answers 200 logged out, add it to the proof scene and the close card of `Demo.tsx` and to `media/src/videos/JudgeGuide.tsx`. Done when: `curl -s -o /dev/null -w '%{http_code}' https://huggingface.co/rizonetech/isitlegit-loupe` prints `200` and the stills show the link.
- [ ] Re-render `pnpm render:demo`, `pnpm render:04` and `pnpm render:teaser`, and update `docs/demo-script.md`. Done when: the three files in `media/out2/` are newer than the last gap closed.
- [ ] Commit: `media: re-cut the videos as the live gaps close (D10 T01 §11)`

**Test checkpoint:** `for u in https://isitlegit.co.za/v/fynbos-freight https://app.isitlegit.co.za/s/fynbos-freight https://huggingface.co/rizonetech/isitlegit-loupe; do curl -s -o /dev/null -w "%{http_code} $u\n" $u; done` prints `200` for each URL cut into the videos.

## 12. P3 review leftovers from the media stamps

The D10 T01 section 2 review found that its historical licence checkpoint accepts an all-capitals placeholder such as `PENDING`. Preserve that stamped contract and add an executable media licence validator for subsequent verification. This checks the recorded evidence format, not whether a provider issued a licence.

> **Started:** 2026-11-04T07:26:43.942156+00:00

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Add `media/tools/check-license.py` to validate the recorded licence line. Done when: exactly one free-tier or company-licence record with a real calendar date passes, while missing, duplicate, malformed and placeholder records fail.
2. Exercise the CLI with synthetic records in `media/tools/test_check_license.py` and invoke it from every `media/package.json` command that calls Remotion render or still, through preflight or a dedicated licence check. Done when: invalid records exit nonzero before rendering and the current recorded free-tier basis passes.

- [ ] D10 T01 §2 round 1 (P3): implement `media/tools/check-license.py`, accepting the existing free-tier record or a company reference of at least six uppercase letters, digits or hyphens starting with a letter or digit; reject `PENDING`, `TBD`, `TODO` and placeholders made by padding those words with hyphens. Done when: the current record passes and placeholder references fail. Cheaper substitute: manually inspecting a line does not prevent a subsequent render from accepting a placeholder.
- [ ] Add CLI regression coverage in `media/tools/test_check_license.py` for free-tier and company records, placeholder references, missing or duplicate records, malformed references and invalid dates. Done when: tests fail against the old checkpoint accepting `PENDING`, then pass with the validator.
- [ ] Guard every package render and still command, including `render:logo`, `render:banner`, `thumbs` and `still:demo`, and document the evidence limit in `media/README.md`. Done when: isolated integration tests execute each real package command with invalid and valid records, proving invalid evidence prevents a renderer sentinel and valid evidence reaches it. Cheaper substitute: a standalone validator or a test of the valid record only cannot prove render refusal.
- [ ] Commit: `media: reject placeholder licence evidence (D10 T01 §12)`

**Test checkpoint:** `python3 -m unittest discover -s media/tools -p 'test_check_license.py' && python3 media/tools/check-license.py && cd media && pnpm preflight` exits 0, and the regression tests prove missing, duplicate, malformed, placeholder and invalid-date records exit nonzero.

## Verification

- Both links play logged out, and each video's closing frame names a commit whose `media/tools/collect-stats.py` output matches the numbers shown.
- `python3 -m unittest discover -s media/tools` passes.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
