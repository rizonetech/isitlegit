# Media lane handover: cloud session to local VS Code

Written 2026-10-30 by the media lane's cloud session, on the operator's decision to move the lane to their own machine (VS Code with Claude Code, a local worktree on branch `claude/trusting-pasteur-umwvqz`). From now on every render and the voiceover run locally; the cloud session is closed. Read [README.md](README.md) and [voiceover/README.md](voiceover/README.md) first.

## Where things stand

| Item | State |
| ---- | ----- |
| Video 01, development process (`data/storyboards/01-development-process.json`) | Storyboard done, 50 facts in `data/dev-facts.json`; about 11 min 37 s; text only so far |
| Video 02, technical deep dive (`data/storyboards/02-technical-deep-dive.json`) | Storyboard done, 92 facts in `data/tech-facts.json`; about 11 min 20 s; text only so far |
| Video 03, Loupe 1.0 (`src/videos/LoupeV1.tsx`) | Done, 52 facts in `data/loupe-facts.json` pinned to glimmer `3be0168e`; 2 min 12 s; text only so far |
| Logo animation (`src/videos/LogoReveal.tsx`) | Done, 1080p, always light, with the original clip's sound |
| Theme | Dark by default (operator, 2026-10-30); `REMOTION_THEME=light` for light |
| Scene changes | Content fades over a steady ground; no dips to black |
| Remotion licence | Free tier: Rizonetech has 3 people (D10 T01 §2, recorded 2026-10-30) |
| Voiceover | Narration in `data/narration/` and the audio wiring done locally (2026-10-30; `src/kit/voice.tsx`, `tools/voice-index.py`, imported clips rather than a second public folder); the operator's ElevenLabs voice `Derick Payne` made 2026-10-30, all 99 clips generated; music bed and effects from `data/sound.json` (`tools/sound.py`); renders mastered to -14 LUFS |
| D10 TODO | `todo/10-media/TODO-01-channel-videos.md`; nothing stamped yet: stamps wait for D00 T01 §26 (the uncoordinated-lane waiver), which the coordinator owns |

Operator decisions so far: dark theme for the explainers; reviewer model names (GPT-6 Astra, Muse Wonder) stay on screen; narration in the operator's ElevenLabs voice; every video 1920 x 1080 at 30 fps.

## Next work, in order

1. **Render locally once, as is.** `cd media && pnpm install --frozen-lockfile && pnpm render:01` (then 02, 03, `render:logo`). Remotion downloads its own Chrome locally, so `REMOTION_BROWSER` is not needed. If pnpm refuses on the root's Node engine check, run the commands in `media/package.json`'s scripts directly. Check stills of every scene (fonts, nothing cut off, no black frames between scenes).
2. **Write the narration scripts**, one file per video: `data/narration/01.json`, `02.json`, `03.json`, each `{"model_id": "eleven_multilingual_v2", "segments": [{"text": "..."}]}` with one segment per on-screen scene in order, the title card first and the closing card last (for 01 and 02 that is 1 + the storyboard's scenes + 1; for 03 the 13 scenes of `LoupeV1`). Spoken English for the ear, not the slide read aloud: explain what the scene shows, in the operator's first person where natural, about 2.5 words per second of the scene's current length (a longer line stretches the scene). Spell out what text-to-speech misreads (for example "SAM three point one", "D one", "one dot one dot one dot two"). Never state a figure the scene does not show, and keep every number identical to its fact. No em or en dashes.
3. **Wire the audio into the videos.**
   - Give Remotion one public folder holding both the brand files and the clips. Either point `remotion.config.ts` at `media/public/` with links `brand`, `fonts` (to `../design/...`) and `voice` (to `out/voice`), or copy the clips into an ignored folder under the public directory. Keep `design/` itself unchanged.
   - Read `out/voice/<video>/manifest.json` when it exists: each scene lasts the longer of its reading time and its clip plus 0.8 s, and plays its clip from the scene's start with Remotion's `<Audio>`.
   - Without a manifest, everything renders silent exactly as now. Keep the reading-time durations and the timing mirror consistent.
   - Test it with short silent MP3s made by ffmpeg, then commit.
4. **Generate the voice**, following steps 5 to 7 of `voiceover/README.md`: a dry run per video, the operator's yes, the real run. Report each clip's length and flag anything over 60 s or under 1 s.
5. **Render the voiced videos** (`pnpm render:01` to `render:03`), loudness about -14 LUFS (ffmpeg `loudnorm` after the render is fine), check the audio sync on a few scenes, and report the files.
6. **Before the final renders**, re-pin `data/dev-facts.json` and `data/tech-facts.json` to the current commit and re-run `pnpm check:facts` so the numbers say what is true on the day; re-check video 02's shipped, partly built and planned marks against `src/` and the stamped rows (D10 T01 §4).
7. **Upload** is the operator's: public, in an `IsItLegit` playlist, altered or synthetic content ticked; record the links in D10 T01 §5 and §7.

## Guardrails

- Touch only `media/` and `todo/10-media/`. Everything else belongs to other lanes or the coordinator; ask, do not change.
- Never commit audio, the voice sample, `out/`, or the API key. The key is read from the environment only and is never printed.
- Every figure on screen comes from `{stats.x}` (the collector) or `{fact.x}` (a pinned quote proven by `tools/check-facts.py`); never type a number.
- No model identifier of the writer in anything committed; tooling is shown as how we build, never as a product feature.
- Tests: `python3 -m unittest discover -s media/tools` and `cd media && pnpm exec tsc -p .`; validate the plan with `python3 scripts/todo-graph.py validate` and `plan --check` after any TODO edit.
- Merging into `main` happens only when the operator asks the coordinator.

### Resume point for Antigravity

Written 2026-10-31 20:58 SAST by the media lane's Claude Code session, parked on the operator's decision (usage at 50%); the lane continues in Antigravity (Gemini 4 Argon, reviewed by Astra). Branch `claude/trusting-pasteur-umwvqz` in the media lane's worktree, pushed. All commands run from `media/`. No AI attribution in commits, no em or en dashes, one line per Markdown paragraph.

### Where things stand

- Videos 01 to 03 (D10): storyboards, narration and pinned facts are synced to the code as of 2026-10-31 (`main` 9344c7c6, glimmer 8e3c97ff). No audio is generated for them: their old clips are stale (`python3 tools/voice-index.py` refuses until they are redone), no render yet, by the operator's order. Re-sync daily: run `pnpm check:facts`, read what changed in the code, edit `data/storyboards/*.json`, `data/narration/*.json` and `data/*-facts.json` together.
- D09 T02 §3 (capture and demo script) and §4 (the 3-minute demo), moved to media on 2026-10-31. Spec and decisions: `docs/specs/2026-10-31-demo-video-design.md` (approved spine, figures with sources, Brian narration draft, flags). Draft 1 is built and committed (`c4862963`); `docs/demo-script.md` and the model-trace demo mode (§3, product code owned by the app lane) are not started. Final capture Tue 3 Nov evening, final render and operator review Wed 4 Nov morning, submit before 18:00 SAST Wed 4 Nov.
- Draft 1 render: `media/out/raw/demo-draft1.mp4` (about 2:20, seven scenes). If that file is missing, run the render command below. The operator has not seen it yet; show it, take their notes.

### The capture rig (`media/capture/`)

- `pnpm capture:demo` (steps `signup | signin | signin-mailbox | beats`; default `beats`) records the live service with Playwright (Chromium build in `~/.cache/ms-playwright`), profile `~/isitlegit-data/media/demo-profile`, output `out/capture/<UTC stamp>/` with a `manifest.json`. `pnpm capture:index` writes the git-ignored `src/data/demo-capture.ts` (newest clean capture, plus the generated shots).
- Beats today: `upload-and-report` (the Karoo Mail lure, `capture/fixtures/karoo-mail-storage.eml`, from `data/demo/fynbos-freight/brand.json`) and `cases`. The invoice bank change, the closed loop and the walkthrough join as their features deploy; a skipped beat is listed, never mocked.
- Tests: `pnpm test:capture` (8 pass). Rules the rig keeps: it never deletes anything (the demo account `demo@rizonetech.com`, org Fynbos Freight and `derick@rizonetech.com` are protected: never delete, reset or clean them), it never clicks sign-out, every selector is scoped by form action, secrets only through environment variables.
- Vault (1Password, vault Conclave, via the service-account token in `~/.conclave/secrets/op-service-account-token.env`; read with `op item get ... --reveal` into an env var, never argv, never printed): `IsItLegit demo mailbox` (field for `CAPTURE_MAILBOX_PASSWORD`; the mailbox is password-only, no MFA), `IsItLegit demo invite code` (`CAPTURE_INVITE`, for `signup` only: 2 uses left, 7 days from 2026-10-31; the member already exists, so it should not be needed again), `ElevenLabs API key (IsItLegit voiceover)` (fields `credential` and `voice_id`).

### Voice and render pipelines

- Voice: Brian, ElevenLabs premade `nPczCjzI2devNBz1zQrb`, set in the vault's `voice_id`. Demo narration `data/narration/demo.json` is on `eleven_v3` (7 clips, made); videos 01 to 03 stay on `eleven_multilingual_v2`. Generate with `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` exported from the vault: `python3 tools/voiceover.py demo --yes` (reuses unchanged clips, so a re-run pays only for edited lines). Then `python3 tools/voice-index.py demo` (name the video; without a name it indexes all and stops on videos 01 to 03's stale clips).
- Render the demo: `pnpm capture:index && RENDER_CONCURRENCY=3 pnpm exec remotion render src/index.ts Demo out/raw/demo-draft2.mp4 --concurrency=3` (never more load than that: the machine runs about eight lanes). Videos 01 to 03 use `pnpm render:01|02|03`, which check facts, index the voice and normalise to -14 LUFS; do not run them until the operator says so.
- Generated footage (Veo clips, OpenAI plates, the abstract background) lives outside the repository in `~/isitlegit-data/media/generated/` (names in `capture/index.ts`, `GENERATED_FILES`); never commit it, never commit voice recordings or audio. The operator's own clone "Derick Payne v2" (`ULhIdGwj7VPzZqCjf79s`) and the candidate Patrick International stay in the ElevenLabs account as fallbacks.

### What is next

- Next: Show the operator draft 1 and take notes. Known gaps: the live report banner still reads "Analysis in progress: checks are not built yet" (the verdict agent is not deployed; the app and checks lanes were told), no music or sound bed for the demo (`data/sound.json` has bed, swell and whoosh for videos 01 to 03), the hero is the Karoo lure not the invoice bank change.
- Next: Swap the abstract background still into videos 01 to 03's `Backdrop` (`src/brand.tsx`) and use the loop for the demo's cards (the loop is already in the demo).
- Next: Build the external-source fact checker (pdfjs-dist 4.10.38 is installed): pin the SABRIC 2025 (p. 7, 9), FBI IC3 2025 (BEC $3,046,598,558), INTERPOL 2025 and SCA [2024] ZASCA 90 figures to their saved PDFs in `~/isitlegit-data/media/sources/` by checksum, page and quote, runnable before a demo render, with tests.
- Next: When the coordinator says `/protect` and the demo-domain fix are deployed (D05 T01 §3 plus the app lane): register the Fynbos Freight protected identity through the member pages with the values from `data/demo/fynbos-freight/brand.json` (logo `logo/mark.svg` or a 512 px PNG, no bank accounts yet), read it back, keep a still, report what was created. If a page refuses a value, stop and send the coordinator the message; do not work around it. Set up the hero case's customer as a second fictional member through the coordinator.
- Next: As each feature deploys, add its beat to `capture/` and its scene to `src/videos/Demo.tsx`; cut the `(live)` lines in the narration draft that stay unproven at the final capture.
- Next: Daily until 4 Nov: re-sync videos 01 to 03, re-capture, regenerate edited clips, re-render the demo. Reviews run through `scripts/review-dispatch.py` as the repository rules say.
