# 03 Loupe 1.0: training a page screener

A technical deep dive in about 2 and a half minutes: what Loupe screens, the base model, the data, the teacher, the splits and their leakage controls, the stopped builds, the training run, the held-out results, the promotion gate and the deployment. 1920 × 1080, 30 fps, on-screen text, narrated in the operator's ElevenLabs voice when `data/narration/03.json` has been voiced (silent otherwise).

Loupe 1.0 is trained (14 h 29 min on 52,019 lines), measured on its 1,000 held-out pages and deployed. Every scene carries the label "Loupe 1.0: figures as of {asOf}, glimmer {commit}"; what is still ahead (the `screenPage` interface, the gate from 1.1 on) carries a dashed tag, and what has run a solid one. Muse Spark's run on the same held-out pages is still going, so no head-to-head is claimed.

## Sources

Every figure comes from `media/data/loupe-facts.json`, which pins each one to the glimmer lane's commit `8e3c97ff` (the admitted count to `3be0168e`, where it was recorded, since the run file that held it was rewritten) and an exact quote from `docs/glimmer/training.md`, `docs/glimmer/sources.md`, `docs/phase-runs/2026-10-30-glimmer-phase-0.md`, `todo/03-vision/TODO-04-glimmer.md` or `scripts/glimmer/`. `media/tools/check-facts.py` refuses a render when any quote is missing at that commit.

## Scenes

| Scene | Seconds | On screen | Visual |
| ----- | ------- | --------- | ------ |
| 1 Title | 5 | Loupe 1.0. Training a page screener on Muse Glimmer 30B. | Logo, status pill |
| 2 The job | 10 | One interface, `screenPage(screenshot, text)`: is this a brand lure with a login or payment form? Loupe answers first; Muse Spark takes over when it cannot. | Screenshot and text feed a Loupe box, a dashed failover arrow to Muse Spark |
| 3 The base model | 10 | Muse Glimmer 30B on Fireworks AI: image input, LoRA tunable, vision encoder frozen, 131,072-token training context. Trained through the Serverless Training API. | Spec sheet card |
| 4 The data | 14 | Seven licensed public sets plus our own benign renders. | Table: source, licence, pages |
| 5 The collection | 10 | 129,892 pages read, 127,890 admitted. Lures by type. | Counters, then four bars: impersonation, credential, fake shop, payment |
| 6 The teacher | 14 | Muse Spark labels South African pages first: 575 checked, 512 agreed, 62 disputed, 1 quarantined, 0 failed. Disputes stay out of training and evaluation. Base Spark recall on confirmed South African lures: 61%. That is the bar. | Stacked bar of outcomes, then the 61% bar line |
| 7 The splits | 16 | No page, near-duplicate or brand group crosses the split. Evaluation: 1,000 pages, 400 lures, teacher-agreed only. The chained-host catch and its fix. | Two boxes and a brand chain |
| 8 The stopped builds | 12 | Builds 1 and 2 refused (lures lost to chained hosts; evaluation 997 of 1,000), build 3 stopped by the out-of-memory guard while publishing, build 4 refused when its read-back found a protected client name; the next published. | Four stamped cards |
| 9 The recipe | 10 | LoRA rank 8, learning rate 1e-4, batch 8, one epoch, sequences up to 8,192 tokens, a checkpoint every 200 steps; 52,019 lines in 14 h 29 min, loss 0.725 to 0.036. | Hyperparameter cards, tagged run |
| 10 The results | 12 | Accuracy 0.958; lure recall 0.980 (392 of 400); false alarms 0.057 (34 of 600); South African lure recall 0.962 (50 of 52); median latency 3.9 s; lure type right 0.635, payment lures mostly typed as another kind; the Spark comparison is still running. | Four score cards and a caveat |
| 11 The gate | 10 | A version ships only if it trained on more lines, was measured on the same held-out file, and its lure recall is no lower and its false-alarm rate no higher, overall and on the South African slice. | Four gate checks |
| 12 Serving | 10 | Deployed on 1 x NVIDIA_H200_141GB, 0 to 1 replicas, scale to zero after 300 s, a 130.7 s cold start; the serving key cannot change the deployment. Versions are never reused. | Card, tagged deployed |
| 13 Data credits | 8 | Dataset authors and licences. | Credits list |
| 14 Close | 5 | github.com/rizonetech/isitlegit. Loupe 1.0: trained, measured, deployed. | Logo |

## Not shown, on purpose

The pilot client's sample mail and anything from it beyond counts, the data store path, the cloud account and vault names, keys, credit and budget amounts, and the source of ground truth for the sample lures. The teacher's spend (US$6.91) is held back until the operator approves showing it.

## Operator decisions and open questions

- Keep the teacher's dollar spend out of the on-screen cards; show only page counts and agreement rates (approved 2026-11-03).
- Show the 61% Muse Spark recall bar as an aggregate rate over the redacted South African sample lures (approved 2026-11-03).
- Narration in the operator's ElevenLabs voice, one segment per scene in [data/narration/03.json](../data/narration/03.json); each scene stays up until its clip ends (operator, 2026-10-30, superseding text only).
- Re-render with the measured Loupe 1.0 results (`52,019` lines, `14 h 29 min`, `0.980` recall, `0.057` false alarms, `3.9 s` median latency, `0.635` lure-type accuracy) and the Loupe 1.1 two-stage cascade (`172,987` frozen pages, `Loupe -> Muse Spark` confidence escalation, `huggingface.co/rizonetech/isitlegit-loupe`) (approved 2026-11-03).

Script approved: 03, 2026-11-03
