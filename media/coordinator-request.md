# Request to the coordinator: register the media lane

Prepared 2026-10-30 for the operator to paste into the coordinator session once it reaches a boundary (no review round or stamp in progress). Not yet sent.

```
Operator request (2026-10-30): register a fifth lane, "media", that the coordinator registers but does not run.

Purpose: promo and explainer videos for the IsItLegit YouTube channel (@DerickPayneDev), made with Remotion. First two: "How IsItLegit is built" (development method, including the Muse Wonder final review through Muse Code) and "IsItLegit in 60 seconds" (tech stack). This is not the demo video: D09 T02 §4 (title cards and architecture animation in `video/`) and D99 T02 §3 to §5 stay as they are.

The lane's work so far is on branch claude/trusting-pasteur-umwvqz, in a self-contained `media/` folder (own package.json and npm lockfile, outside pnpm-workspace.yaml, the root lockfile, Biome and tsconfig).

Please do, on main:
1. Allocate domain D10 `10-media` and add it to the TODO index (`todo/TODO-00-INDEX.md` and the domain list in `todo/README.md`) with a stub `todo/10-media/INDEX.md`, so `scripts/todo-graph.py validate` passes. The media lane writes its own TODO file in it.
2. Add the lane to `todo/lanes.json`: "media": {"branch": "claude/trusting-pasteur-umwvqz", "domains": ["D10"]}. If the lane schema can mark a lane as uncoordinated, use that; if not, tell me how you would mark it.
3. Exclude D10 from coordinator control: no process-plan runs, no run guard or heartbeat blocking on its rows, no review rounds required for its stamps, and no merges into main except when the operator asks. Its rows must not appear in other lanes' `query ready`.
4. Add a short amendment to `docs/specs/2026-10-30-four-lanes-design.md` recording the fifth lane and the rules above.
5. Confirm the self-contained `media/` folder is acceptable, or say what you prefer.
6. Note in `CONTRIBUTIONS.md` (or tell me where it belongs) that the review tooling shown in the development method video is pre-existing development tooling, not a product feature.

The media lane touches only `media/` and `todo/10-media/`, does not edit `scripts/`, `.claude/`, `.conclave/`, `todo/lanes.json` or any other domain, and does not use the Meta Model API.

Reply with: the main commit that holds steps 1 to 4, and your decision on steps 3 and 5.
```

After the reply: merge `main` into this branch, move the scripts into a D10 TODO file (one section per video), and update [README.md](README.md).
