# 01 How IsItLegit is built

The development process in full, for learning and for the channel: about 11 and a half minutes, 1920 × 1080, on-screen text, no voiceover unless the operator records one. Long form on the operator's request (2026-10-30): it is not part of the demo video, so it takes the time the material needs. Every scene carries the label "Our development process, not a product feature".

The script is the storyboard [data/storyboards/01-development-process.json](../data/storyboards/01-development-process.json): every scene's words, in order. Figures are named, never typed: `{stats.x}` is read from git and the plan at render time by `tools/collect-stats.py`, and `{fact.x}` comes from [data/dev-facts.json](../data/dev-facts.json), each pinned to a commit and an exact quote that `tools/check-facts.py` proves before a render.

## The story

One operator directing a team of AI lanes that works around the clock, a coordinator as team lead, and independent reviewers from other model families as quality control.

## Chapters

| Chapter | What it covers |
| ------- | -------------- |
| 1 The idea | The manifesto's bet, the build so far (commits, stamped sections, lines of TypeScript, lane merges), the judging weights |
| 2 The rules everyone follows | The governing documents and the house rules |
| 3 The plan is a graph | Domains, files, sections and phases, the Implementation Order graph, stamped sections per domain, the todo-graph commands |
| 4 A section is a contract | Phase, Needs, Risk, Surface, Adjacency, the test checkpoint, the five-part micro-step rule, a real section from this lane's plan |
| 5 The lanes: a team of five | Coordinator, checks, app, Glimmer and media lanes; why split by domain (7 shared dependencies, not 22); lane scoping in the tools |
| 6 The coordinator: team lead | How work reaches main, what the coordinator owns, migration numbers, operator steps, sharing one machine |
| 7 The loop that never stops | process-plan to stamp, the stop hook, heartbeat and handover; commits by hour of day and per day |
| 8 Quality control | Writer and reviewers, the review schedule, the rules of a review, review counts, a real Muse Wonder finding; the final review is off since 29 Oct while the weekly Muse limit is reached |
| 9 Nothing ships without a receipt | The stamp command and its evidence; the media lane's waived stamps |
| 10 Guards on every action | Hooks, check-publication, local-tool-safety, CI's jobs |
| 11 How it adds up to speed | Five parts, one machine; the result so far |

## Not shown, on purpose

Client data, account and vault names, keys, budgets, and the model identifier of the writer.

## Operator decisions

- Text only for now; a voiceover is planned for later, recorded by the operator against the finished cut (operator, 2026-10-30).
- Keep the reviewer model names (GPT-6 Astra, Muse Wonder) on screen, for authenticity (operator, 2026-10-30).
