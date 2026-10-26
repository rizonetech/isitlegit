## What this changes

<!-- One or two sentences. Link the TODO section this ships, for example D00 T01 §1. -->

## Evidence

<!-- The section's Test checkpoint, quoted: the command run and its result. -->

## Safety contract

- [ ] No verdict can fall below the deterministic floor, and every verdict claim cites an Evidence ID (`AGENTS.md`).
- [ ] Untrusted content (mail, page, PDF, transcript text) reaches a model only inside an untrusted block, and model output passes a zod schema before use.
- [ ] No real client mail, client name, secret or private path is in code, fixtures, logs or this description.
