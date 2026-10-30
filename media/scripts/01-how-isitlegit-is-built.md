# 01 How IsItLegit is built

Our development process in about 65 seconds, for the channel and the hackathon judges. 1920 × 1080, 30 fps, on-screen text, no voiceover unless the operator records one.

On screen from the first second: "Our development process. Not a product feature."

## Scenes

| Scene | Seconds | On screen | Visual |
| ----- | ------- | --------- | ------ |
| 1 Title | 5 | How IsItLegit is built. Our development process, not a product feature. | IsItLegit logo on Ink, the question mark's dot becomes the tick |
| 2 The plan | 8 | One plan, {sections} small sections. Each one testable on its own. | A grid of {sections} squares; the stamped ones fill orange |
| 3 The writer | 8 | Claude Code builds one section at a time: code, tests, commit. | A section card whose checklist ticks off, ending on a commit line |
| 4 The reviewer | 12 | A different model family reviews every section. GPT-6 Astra: a plan review, a completion review, then adversarial rounds at falling effort until a round finds no P1 or P2. | Round bars labelled high, medium, low, the last one green |
| 5 The final review | 12 | Then one final review by Muse Wonder, through Muse Code. A P1 or P2 it finds is fixed and proven by one more round. | A review card quoting a real finding from `docs/reviews/01-intake/D01-T01-s2.md`: "the expired-object restore path can desynchronise R2, D1 and the returned media type" |
| 6 The receipt | 8 | Nothing ships without a receipt. | `todo-graph.py stamp` writes the Verified stamp; the receipt file lands in `docs/reviews/` |
| 7 So far | 8 | {stamped} sections shipped. {rounds} review rounds. {finals} Muse final reviews. As of {date}. | Three counters rolling up |
| 8 Close | 4 | github.com/rizonetech/isitlegit. Development tooling is declared in CONTRIBUTIONS.md. | Logo, link |

## Numbers

Read at render time by `media/tools/collect-stats.py`. On this branch on 2026-10-30: 268 sections, 86 stamped, 335 review rounds, 65 Muse Wonder final reviews.

## Open questions for the operator

- Voiceover or text only?
- Show the real reviewer names (GPT-6 Astra, Muse Wonder) or roles only ("a second model family", "a third model family")?
