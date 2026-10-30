# Media

Promo and explainer videos for the IsItLegit YouTube channel ([@DerickPayneDev](https://www.youtube.com/@DerickPayneDev)), made with Remotion.

This folder belongs to the media lane (branch `claude/trusting-pasteur-umwvqz`). The lane is waiting to be registered by the coordinator as domain D10 `10-media`; the request is in [coordinator-request.md](coordinator-request.md). Until then nothing here is in the TODO graph.

## Rules

- The demo video is not made here: its title cards and architecture animation are D09 T02 §4 (`video/`, checks lane), and recording and upload are D99 T02 §3 to §5 (operator).
- This folder is self-contained: its own `package.json` and lockfile, installed with npm, outside `pnpm-workspace.yaml`, the root lockfile, Biome and the TypeScript build.
- Brand files, fonts and colours come from `design/` unchanged (`design/brand/README.md`).
- Every number on screen is read from the repository at render time, never typed in.
- Development tooling (Claude Code, GPT-6 Astra, the Muse Wonder final review) is shown as how we build, never as a product feature, and is declared in `CONTRIBUTIONS.md`.
- No Meta Model API calls, no client data, nothing we lack the rights to publish. Music only with a licence on file.

## Videos

| Number | Video | Script | Status |
| ------ | ----- | ------ | ------ |
| 01 | How IsItLegit is built (development method) | [scripts/01-how-isitlegit-is-built.md](scripts/01-how-isitlegit-is-built.md) | Draft, awaiting operator approval |
| 02 | IsItLegit in 60 seconds (tech stack) | [scripts/02-isitlegit-in-60-seconds.md](scripts/02-isitlegit-in-60-seconds.md) | Draft, awaiting operator approval |
