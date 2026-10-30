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
| Voiceover | Narration in `data/narration/` and the audio wiring done locally (2026-10-30; `src/kit/voice.tsx`, `tools/voice-index.py`, imported clips rather than a second public folder); voice clone `Derick Payne` made 2026-10-30, all 99 clips generated; music bed and effects from `data/sound.json` (`tools/sound.py`); renders mastered to -14 LUFS |
| D10 TODO | `todo/10-media/TODO-01-channel-videos.md`; nothing stamped yet: stamps wait for D00 T01 §26 (the uncoordinated-lane waiver), which the coordinator owns |

Operator decisions so far: dark theme for the explainers; reviewer model names (GPT-6 Astra, Muse Wonder) stay on screen; text only until the cloned voiceover lands; ElevenLabs hosted cloning; every video 1920 x 1080 at 30 fps.

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
7. **Upload** is the operator's: public, in an `IsItLegit` playlist, altered or synthetic content ticked for the cloned voice; record the links in D10 T01 §5 and §7.

## Guardrails

- Touch only `media/` and `todo/10-media/`. Everything else belongs to other lanes or the coordinator; ask, do not change.
- Never commit audio, the voice sample, `out/`, or the API key. The key is read from the environment only and is never printed.
- Every figure on screen comes from `{stats.x}` (the collector) or `{fact.x}` (a pinned quote proven by `tools/check-facts.py`); never type a number.
- No model identifier of the writer in anything committed; tooling is shown as how we build, never as a product feature.
- Tests: `python3 -m unittest discover -s media/tools` and `cd media && pnpm exec tsc -p .`; validate the plan with `python3 scripts/todo-graph.py validate` and `plan --check` after any TODO edit.
- Merging into `main` happens only when the operator asks the coordinator.
