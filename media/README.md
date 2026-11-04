# Media

Promo and explainer videos for the IsItLegit YouTube channel ([@DerickPayneDev](https://www.youtube.com/@DerickPayneDev)), made with Remotion.

Moving to local VS Code: see [HANDOVER.md](HANDOVER.md).

This folder belongs to the media lane (branch `claude/trusting-pasteur-umwvqz`, domain D10 `10-media`), registered by the coordinator on `main` in `b223a08` and not run by it (`docs/specs/2026-10-30-four-lanes-design.md`, Amendment: a fifth lane). The work is planned in [todo/10-media/](../todo/10-media/INDEX.md).

## Rules

- The demo video is not made here: its title cards and architecture animation are D09 T02 §4 (`video/`, checks lane), and recording and upload are D99 T02 §3 to §5 (operator).
- This folder is its own pnpm root: `media/pnpm-workspace.yaml` and `media/pnpm-lock.yaml`, never the root workspace or lockfile, and outside Biome, the TypeScript build and Vitest.
- Every video is 1920 x 1080 at 30 fps (operator, 2026-10-30): compositions take `VIDEO` from `src/Root.tsx`, never their own size.
- Brand files, fonts and colours come from `design/` unchanged (`design/brand/README.md`).
- The explainers use the dark theme from `design/tokens/colors.json` on the brand's Ink ground with the on-dark logo (operator, 2026-10-30); `REMOTION_THEME=light` renders the light theme. The logo animation is always light, matching the original clip.
- Every number on screen is read from the repository at render time (`{stats.x}`) or pinned to a commit and an exact quote (`{fact.x}`, proven by `tools/check-facts.py`), never typed in.
- Development tooling (Claude Code, GPT-6 Astra, the Muse Wonder final review) is shown as how we build, never as a product feature, and is declared in `CONTRIBUTIONS.md`.
- No Meta Model API calls, no client data, nothing we lack the rights to publish. Music only with a licence on file: the channel bed and sound effects are generated with ElevenLabs (Eleven Music, Sound Effects) on the operator's paid plan from the prompts in `data/sound.json`, used under the ElevenLabs terms for that plan (operator, 2026-10-30).

## Licences

- Remotion 4.0.539 (`remotion`, `@remotion/cli`, pinned in `package.json`): used under the Remotion licence (`https://www.remotion.dev/license`), free tier for individuals and companies of up to three people. Rizonetech has three people (operator, 2026-10-30; recorded in D10 T01 §2). Remotion renders the channel and demo videos only: it is a dependency of this folder's own pnpm root only and is never shipped in the product or the Worker. If Rizonetech grows past three people, a company licence is bought before the next render.
- ElevenLabs music, sound effects and narration: the operator's paid plan, as in the rules above.

## Videos

| Number | Video | Script | Status |
| ------ | ----- | ------ | ------ |
| 01 | How IsItLegit is built: the development process, long form (about 11.5 min) | [scripts/01-how-isitlegit-is-built.md](scripts/01-how-isitlegit-is-built.md) | Script updated 31 Oct to main `9344c7c6`; re-render pending |
| 02 | IsItLegit: how it works, the technical deep dive, long form (about 11 min) | [scripts/02-isitlegit-technical-deep-dive.md](scripts/02-isitlegit-technical-deep-dive.md) | Script updated 31 Oct to main `9344c7c6`; re-render pending |
| 03 | Loupe 1.0: training a page screener (technical) | [scripts/03-loupe-1-0.md](scripts/03-loupe-1-0.md) | Script updated 31 Oct for the trained, measured and deployed Loupe 1.0; re-render pending |
| Logo | IsItLegit logo animation, rebuilt at 1080p from the brand geometry | n/a | Rendered; replaces the 720p `design/brand/videos/logo_animation.mp4` for YouTube |

## Render

Every package render and still command validates the recorded Remotion licence basis first (`pnpm check:license`). Missing, duplicate, malformed, placeholder and invalid-date records stop rendering. This validates the evidence format; it does not verify provider entitlement or replace the recorded operator confirmation.

Needs Node 22 or newer, pnpm, and Python 3.11 or newer with numpy (`python3 -m pip install --user numpy`, or `sudo apt install python3-numpy`), which `tools/master.py` uses to master each render's sound. Every render that masters its sound runs `pnpm preflight` (`tools/preflight.py`) first, so a missing numpy or an old Python stops it before the first frame with the command that installs it. From `media/`:

```bash
pnpm install --frozen-lockfile
pnpm render:01   # out2/01-how-isitlegit-is-built.mp4, about 11.5 min, 1920 x 1080
pnpm render:02   # out2/02-isitlegit-technical-deep-dive.mp4, about 11 min, 1920 x 1080
pnpm render:03   # out2/03-loupe-1-0.mp4, 132 s, 1920 x 1080 (runs check:facts first)
pnpm render:logo # out2/isitlegit-logo-animation-1080p.mp4, 8 s, 1920 x 1080, with the original clip's sound
pnpm studio      # preview and scrub in the browser
```

Each render first runs `tools/collect-stats.py`, which writes the on-screen numbers to `src/data/stats.json` (git-ignored). Set `REMOTION_BROWSER` to an installed Chrome when Remotion cannot download its own; in the cloud session that is `/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Videos 01 and 02 are storyboards in `data/storyboards/`, rendered by the scene kit in `src/kit/` (chapter, bullets, table, flow, code, stats, chart, lanes and callout scenes, each timed by its reading length); video 03 and the logo are hand-built in `src/videos/`. The shared brand layer is `src/brand.tsx`, and `remotion.config.ts` serves `design/` as the public folder.

Figures come from `data/dev-facts.json` (video 01), `data/tech-facts.json` (video 02) and `data/loupe-facts.json` (video 03), each pinned to a commit and an exact quote (or a counted pattern) in its source. `pnpm check:facts` proves them with `git show` (a fact may name its own `commit` when a later rewrite of its source dropped the line), so each pinned commit must be fetched (`git fetch origin glimmer-screener` for video 03), and refuses a storyboard that names an undefined fact; a render stops when any figure no longer matches. Videos 01 to 03 are narrated in the operator's ElevenLabs voice once `tools/voiceover.py` has made their clips from `data/narration/` ([voiceover/README.md](voiceover/README.md)); `tools/sound.py` makes the music bed and effects from `data/sound.json`. Every render runs `tools/voice-index.py` first, and a video without clips or sound renders without them. Renders go to `out2/raw/` and are then mastered to -14 LUFS into `out2/` (thumbnails and captures stay in `out/`). Every render uses two threads unless `RENDER_CONCURRENCY` names another whole number from 1 to 8 (`remotion.config.ts`; the scripts pass no `--concurrency`, so the setting holds for all of them, and `RENDER_CONCURRENCY=1` is the lightest on the shared machine). Tests, from `media/`: `python3 -m unittest discover -s tools`, `pnpm test:kit` and `pnpm test:capture`.

## Demo capture

The demo video (D09 T02 §3 and §4, `docs/specs/2026-10-31-demo-video-design.md`) records the live service, `app.isitlegit.co.za`, with Playwright. `pnpm capture:demo` signs in as the demo member (`demo@rizonetech.com`, organisation Fynbos Freight) through a persistent browser profile in `~/isitlegit-data/media/demo-profile/`, uploads this run's copy of each synthetic fixture in `capture/fixtures/` (fictional businesses, `.example` domains only), and writes each beat's 1920 x 1080 video, stills and a `manifest.json` (case IDs, the live commit from `/health`, timing marks and the on-screen boxes scenes zoom to) to `out/capture/<UTC stamp>/`. A beat that cannot run is skipped, listed in the manifest, and the run exits 1. `pnpm capture:demo signin` signs the member in again by reading the app's sign-in link from the demo mailbox in Outlook on the web (it takes only a mail that arrives after it asks, since the mailbox is never cleaned); `pnpm capture:demo signin-mailbox` signs the profile in to Outlook again with `CAPTURE_MAILBOX_PASSWORD` from the vault item `IsItLegit demo mailbox`. The demo member, Fynbos Freight, its cases and its mailbox are protected (operator, 2026-10-31): nothing in the rig deletes, resets or moves their data; `pnpm capture:demo signup` was run once on 2026-10-31 with the invite code from the vault item `IsItLegit demo invite code`, passed in `CAPTURE_INVITE` only. Tests: `pnpm test:capture`.
