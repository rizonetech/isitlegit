# 03 Loupe 1.0: training a page screener

A technical deep dive in about 2 minutes 12 seconds: what Loupe screens, the base model, the data, the teacher, the splits and their leakage controls, the two refused builds, the training recipe, the promotion gate and the serving plan. 1920 × 1080, 30 fps, on-screen text, no voiceover unless the operator records one.

Loupe 1.0 is not trained yet. Every scene carries the status label "Loupe 1.0, in preparation: figures as of {asOf}, glimmer {commit}", measured figures are shown plain, and planned values carry a "planned" tag. No accuracy, latency or cost result is claimed until one is recorded.

## Sources

Every figure comes from `media/data/loupe-facts.json`, which pins each one to the glimmer lane's commit `3be0168e` and an exact quote from `docs/glimmer/training.md`, `docs/glimmer/sources.md`, `docs/phase-runs/2026-10-30-glimmer-phase-0.md`, `todo/03-vision/TODO-04-glimmer.md` or `scripts/glimmer/`. `media/tools/check-facts.py` refuses a render when any quote is missing at that commit.

## Scenes

| Scene | Seconds | On screen | Visual |
| ----- | ------- | --------- | ------ |
| 1 Title | 5 | Loupe 1.0. Training a page screener on Muse Glimmer 30B. | Logo, status pill |
| 2 The job | 10 | One interface, `screenPage(screenshot, text)`: is this a brand lure with a login or payment form? Loupe answers first; Muse Spark takes over when it cannot. | Screenshot and text feed a Loupe box, a dashed failover arrow to Muse Spark |
| 3 The base model | 10 | Muse Glimmer 30B on Fireworks AI: image input, LoRA tunable, vision encoder frozen, 131,072-token training context. Trained through the Serverless Training API. | Spec sheet card |
| 4 The data | 14 | Seven licensed public sets plus our own benign renders. | Table: source, licence, pages |
| 5 The collection | 10 | 129,892 pages read, 127,890 admitted. Lures by type. | Counters, then four bars: impersonation, credential, fake shop, payment |
| 6 The teacher | 14 | Muse Spark labels South African pages first: 575 checked, 512 agreed, 62 disputed, 1 quarantined, 0 failed. Disputes stay out of training and evaluation. Base Spark recall on confirmed South African lures: 61%. That is the bar. | Stacked bar of outcomes, then the 61% bar line |
| 7 The splits | 16 | No page, near-duplicate or brand group crosses the split. Evaluation: 1,000 pages, at most 40% lures, teacher-agreed only. The catch: grouping by registrable domain chained 57 brands on weebly.com into one 28,334-page group; groups are now keyed by full host. | Train and eval boxes; a chain of brand chips collapsing into one group, then splitting |
| 8 Two refused builds | 10 | Build 1: 2 h 35 min, 2.4 GB, refused (training kept 29 of 100 sample-derived lures). Build 2: 1 h 16 min, refused by 3 pages (997 of 1,000). Both fixes are in `build-dataset.ts` with tests. | Two build cards stamped "refused", each with its fix |
| 9 The recipe | 10 | LoRA rank 8, learning rate 1e-4, batch 8, one epoch, sequences up to 8,192 tokens, a checkpoint every 200 steps. | Hyperparameter table, tagged planned |
| 10 The gate | 12 | A version ships only if it trained on more lines, was measured on the same held-out file, and its lure recall is no lower and its false-alarm rate no higher, overall and on the South African slice. | Four gate checks |
| 11 Serving | 8 | One H100 80 GB deployment, 0 to 1 replicas, scale to zero after 300 s. Versions are never reused: isitlegit-loupe-1-0. | Deployment card |
| 12 Data credits | 8 | Dataset authors and licences. | Credits list |
| 13 Close | 5 | github.com/rizonetech/isitlegit. Loupe 1.0 results follow in the model card. | Logo |

## Not shown, on purpose

The pilot client's sample mail and anything from it beyond counts, the data store path, the cloud account and vault names, keys, credit and budget amounts, and the source of ground truth for the sample lures. The teacher's spend (US$6.91) is held back until the operator approves showing it.

## Open questions for the operator

- Show the teacher's spend (US$6.91), or keep costs out?
- Show the 61% Muse Spark recall bar? It is an aggregate over the pilot client's redacted sample lures; only the count and the rate would appear.
- Voiceover or text only?
- Re-render after Loupe 1.0 trains, adding a results scene from the model card?
