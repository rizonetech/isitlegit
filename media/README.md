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
- No Meta Model API calls, no client data, nothing we lack the rights to publish. Music only with a licence on file.

## Videos

| Number | Video | Script | Status |
| ------ | ----- | ------ | ------ |
| 01 | How IsItLegit is built: the development process, long form (about 11.5 min) | [scripts/01-how-isitlegit-is-built.md](scripts/01-how-isitlegit-is-built.md) | Rendered, awaiting operator approval |
| 02 | IsItLegit: how it works, the technical deep dive, long form (about 11 min) | [scripts/02-isitlegit-technical-deep-dive.md](scripts/02-isitlegit-technical-deep-dive.md) | Rendered, awaiting operator approval |
| 03 | Loupe 1.0: training a page screener (technical) | [scripts/03-loupe-1-0.md](scripts/03-loupe-1-0.md) | First render, awaiting operator approval; Loupe 1.0 not yet trained |
| Logo | IsItLegit logo animation, rebuilt at 1080p from the brand geometry | n/a | Rendered; replaces the 720p `design/brand/videos/logo_animation.mp4` for YouTube |

## Render

Needs Node 22 or newer and Python 3.11 or newer. From `media/`:

```bash
pnpm install --frozen-lockfile
pnpm render:01   # out/01-how-isitlegit-is-built.mp4, about 11.5 min, 1920 x 1080
pnpm render:02   # out/02-isitlegit-technical-deep-dive.mp4, about 11 min, 1920 x 1080
pnpm render:03   # out/03-loupe-1-0.mp4, 132 s, 1920 x 1080 (runs check:facts first)
pnpm render:logo # out/isitlegit-logo-animation-1080p.mp4, 8 s, 1920 x 1080, with the original clip's sound
pnpm studio      # preview and scrub in the browser
```

Each render first runs `tools/collect-stats.py`, which writes the on-screen numbers to `src/data/stats.json` (git-ignored). Set `REMOTION_BROWSER` to an installed Chrome when Remotion cannot download its own; in the cloud session that is `/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Videos 01 and 02 are storyboards in `data/storyboards/`, rendered by the scene kit in `src/kit/` (chapter, bullets, table, flow, code, stats, chart, lanes and callout scenes, each timed by its reading length); video 03 and the logo are hand-built in `src/videos/`. The shared brand layer is `src/brand.tsx`, and `remotion.config.ts` serves `design/` as the public folder.

Figures come from `data/dev-facts.json` (video 01), `data/tech-facts.json` (video 02) and `data/loupe-facts.json` (video 03), each pinned to a commit and an exact quote (or a counted pattern) in its source. `pnpm check:facts` proves them with `git show`, so each pinned commit must be fetched (`git fetch origin glimmer-screener` for video 03), and refuses a storyboard that names an undefined fact; a render stops when any figure no longer matches. Tests: `python3 -m unittest discover -s media/tools`.
