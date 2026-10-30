# Media

Promo and explainer videos for the IsItLegit YouTube channel ([@DerickPayneDev](https://www.youtube.com/@DerickPayneDev)), made with Remotion.

This folder belongs to the media lane (branch `claude/trusting-pasteur-umwvqz`, domain D10 `10-media`), registered by the coordinator on `main` in `b223a08` and not run by it (`docs/specs/2026-10-30-four-lanes-design.md`, Amendment: a fifth lane). The work is planned in [todo/10-media/](../todo/10-media/INDEX.md).

## Rules

- The demo video is not made here: its title cards and architecture animation are D09 T02 §4 (`video/`, checks lane), and recording and upload are D99 T02 §3 to §5 (operator).
- This folder is its own pnpm root: `media/pnpm-workspace.yaml` and `media/pnpm-lock.yaml`, never the root workspace or lockfile, and outside Biome, the TypeScript build and Vitest.
- Brand files, fonts and colours come from `design/` unchanged (`design/brand/README.md`).
- Every number on screen is read from the repository at render time, never typed in.
- Development tooling (Claude Code, GPT-6 Astra, the Muse Wonder final review) is shown as how we build, never as a product feature, and is declared in `CONTRIBUTIONS.md`.
- No Meta Model API calls, no client data, nothing we lack the rights to publish. Music only with a licence on file.

## Videos

| Number | Video | Script | Status |
| ------ | ----- | ------ | ------ |
| 01 | How IsItLegit is built (development method) | [scripts/01-how-isitlegit-is-built.md](scripts/01-how-isitlegit-is-built.md) | First render, awaiting operator approval |
| 02 | IsItLegit in 60 seconds (tech stack) | [scripts/02-isitlegit-in-60-seconds.md](scripts/02-isitlegit-in-60-seconds.md) | First render, awaiting operator approval |

## Render

Needs Node 22 or newer and Python 3.11 or newer. From `media/`:

```bash
pnpm install --frozen-lockfile
pnpm render:01   # out/01-how-isitlegit-is-built.mp4, 65 s, 1920 x 1080
pnpm render:02   # out/02-isitlegit-in-60-seconds.mp4, 60 s, 1920 x 1080
pnpm studio      # preview and scrub in the browser
```

Each render first runs `tools/collect-stats.py`, which writes the on-screen numbers to `src/data/stats.json` (git-ignored). Set `REMOTION_BROWSER` to an installed Chrome when Remotion cannot download its own; in the cloud session that is `/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Scenes and timings live in `src/videos/`, the shared brand layer in `src/brand.tsx`, and `remotion.config.ts` serves `design/` as the public folder.
