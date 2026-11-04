# Loupe model card

One part per version, made from the run's own records by `scripts/glimmer/model_card.py`.

## Loupe 1.1 release addendum

Updated 4 November 2026. This maintained release addendum is separate from the generated historical 1.0 card below. The [release evidence record](release-status.md) provides the source identities, measured diagnostics and unresolved limits. It is not a completed independent evaluation card.

Loupe 1.1 is a LoRA fine-tune of Meta Muse Glimmer 30B, trained through Fireworks AI on 72,375 supervised examples in one epoch and 4,524 optimizer steps, with seven examples in the last batch. These are page-specific training conversations sharing a canonical instruction, not 72,375 unique instructions or independent websites. Final artifact: `accounts/rizonetech/models/isitlegit-loupe-1-1`, checkpoint `step-4524`, training session `ts-db85d8de82174aa6824b775ca6e40075`. The answer contract is brand-free: form presence, lure, lure type and confidence, validated strictly before use.

On the preregistered 40-page synthetic v2 diagnostic, both 1.0 and 1.1 returned 40 valid responses and no errors. Both produced TP20, FP20, TN0 and FN0: accuracy 20/40 (50%), lure recall 20/20 (100%) and false alarms 20/20 (100%). This is a poor result and shows no classification improvement. The baseline received the common brand-free prompt, so it is not a benchmark of its native contract. Ten related layout families and one generator family do not establish independence.

Candidate median latency was 2,067 ms and p95 4,388 ms, against baseline median 2,088 ms and p95 4,224 ms on this diagnostic. Candidate lure-type accuracy was 50%, baseline 85%. Six additional candidate calls using text-only and image-only inputs returned six valid responses naming the exact model; both benign cases remained false positives in both modalities. Prompt or dataset mismatch remains a hypothesis, not a proven cause. These observations do not establish a general accuracy rate or production latency guarantee.

The operator authorized operational rollout with these limitations disclosed. Deployment is in progress, not yet verified live in this snapshot. Independent qualification remains unmet, including incomplete source/template lineage and exclusion against both training exports, 17 recorded provenance issues and 257 baseline-training overlaps. The small synthetic diagnostic does not satisfy D03 T04 §50. Loupe supplies screening evidence, never authority to override the deterministic safety floor or invent evidence.

Training and inference use Fireworks AI; the Cloudflare Worker orchestrates calls through AI Gateway rather than executing weights locally. No Hugging Face publication is claimed or planned for this release. Dataset source licences and restrictions remain in [sources](sources.md); this addendum does not grant new redistribution rights. Keep the historical 1.0 card's licence, provenance and version-specific measurements separate.

## Loupe 1.0

`isitlegit-loupe-1-0`, a LoRA (rank 8) of Muse Glimmer 30B (accounts/fireworks/models/muse-glimmer-30b), trained by LoRA supervised fine-tuning on Fireworks' Serverless Training API (the Fireworks cookbook's SFT loop), 2026-10-30T22:20:28+00:00 to 2026-10-31T12:49:52+00:00.

Contents: [Where Loupe 1.0 stands](#where-loupe-10-stands), [Results of Loupe 1.0](#results-of-loupe-10), [Training of Loupe 1.0](#training-of-loupe-10), [Deployment of Loupe 1.0](#deployment-of-loupe-10), [Limits of Loupe 1.0](#limits-of-loupe-10).

Intended use: Screening candidate pages for IsItLegit's impersonation monitor: a first answer on whether a page is a brand lure with a login or payment form, never the final verdict, which the evidence rules and Muse Spark decide.

## Where Loupe 1.0 stands

Loupe 1.0 does not yet meet the project's own standard. It ships under a time-boxed bar set for the competition deadline, not because the result is considered good enough.

The bar it was judged on: lure recall at least Muse Spark's and false alarms at most 6 percent, on the held-out evaluation set and on the independent reference set (operator, 2026-10-31). Result: passed.

- Evaluation set (1000 pages): Loupe's lure recall 98.0% (392 of 400) against Muse Spark's 94.2% (377 of 400), false alarms 5.7% (34 of 600); South African slice: lure recall 96.2% (50 of 52) against Muse Spark's 94.2% (49 of 52), false alarms 5.5% (27 of 493).
- Independent reference set, drawn before any Muse Spark check (493 pages): Loupe's lure recall 92.3% (84 of 91) against Muse Spark's 61.5% (56 of 91), false alarms 3.7% (15 of 402); South African slice not judged (0 lures, 2 benign, under the 30 each it needs).

The project's standard, set for Loupe 1.1 as the target it is built to meet: false alarms at most 2 percent, and lure recall above Muse Wonder's on the same pages.
- False alarms: 5.7 percent at their highest of the two sets, so the part is not met.
- Lure recall: Muse Wonder's recall on these pages is not measured yet, so this part is a target, not a comparison.

Known causes of its misses and false alarms (42 pages, each confirmed): 12 brand absent from training: the brand's own page (its site, its login, or its account on a social platform); 10 brand absent from training: a small real site with no lure, flagged for being unfamiliar; 6 wrong label?: the capture is a wall or an empty page, not the site (a capture rule should have left it out); 3 lure type underrepresented: a legitimate notice that reads like a lure; 3 brand absent from training: a real site that names a brand it is not (a news, fan or information site); 3 lure type underrepresented: a fake shop or lookalike with no copied brand page; 2 lure type underrepresented: a support-number scam posted on a legitimate host; 1 lure type underrepresented: a lure mail with no brand or link in its text; 1 wrong label?: the page shows no lure of the labelled kind; 1 lure type underrepresented: a kit page that shows only its error messages.

The work on them for Loupe 1.1: D03 T04 §25 and §27 to §29. They name what 1.1 is built to answer, not what it will reach.

### Results of Loupe 1.0

| Held-out evaluation set | Loupe | Muse Spark |
| --- | --- | --- |
| Lure recall | 98.0% (392 of 400) | 94.2% (377 of 400) |
| False alarm rate | 5.7% (34 of 600) | 0.2% (1 of 600) |
| Accuracy | 95.8% (958 of 1000) | 97.6% (976 of 1000) |
| Median latency | 3.9 s | 8.7 s |
| Cost per page | not known per page | US$0.0076 |

| Slice | Screener | Pages | Lure recall | False alarms | Accuracy | Median latency | Cost per page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| South Africa | Loupe | 545 (52 lures, 493 benign) | 96.2% (50 of 52) | 5.5% (27 of 493) | 94.7% (516 of 545) | 4.0 s | not known per page |
| South Africa | Muse Spark | 545 (52 lures, 493 benign) | 94.2% (49 of 52) | 0.0% (0 of 493) | 99.4% (542 of 545) | 8.6 s | US$0.0072 |
| credential | Loupe | 80 (80 lures, 0 benign) | 97.5% (78 of 80) | n/a | 97.5% (78 of 80) | 3.6 s | not known per page |
| credential | Muse Spark | 80 (80 lures, 0 benign) | 91.2% (73 of 80) | n/a | 91.2% (73 of 80) | 8.1 s | US$0.0070 |
| fake shop | Loupe | 139 (139 lures, 0 benign) | 99.3% (138 of 139) | n/a | 99.3% (138 of 139) | 4.0 s | not known per page |
| fake shop | Muse Spark | 139 (139 lures, 0 benign) | 97.1% (135 of 139) | n/a | 97.1% (135 of 139) | 9.3 s | US$0.0091 |
| impersonation | Loupe | 103 (103 lures, 0 benign) | 95.1% (98 of 103) | n/a | 95.1% (98 of 103) | 3.8 s | not known per page |
| impersonation | Muse Spark | 103 (103 lures, 0 benign) | 92.2% (95 of 103) | n/a | 92.2% (95 of 103) | 9.6 s | US$0.0084 |
| payment | Loupe | 78 (78 lures, 0 benign) | 100.0% (78 of 78) | n/a | 100.0% (78 of 78) | 3.7 s | not known per page |
| payment | Muse Spark | 78 (78 lures, 0 benign) | 94.9% (74 of 78) | n/a | 94.9% (74 of 78) | 9.1 s | US$0.0076 |

False alarms by benign source: ariyadasa-2021 0.0% (0 of 29); benign-majestic 6.6% (12 of 183); benign-sa 4.5% (11 of 246); compphish 7.1% (1 of 14); kempf-html 0.0% (0 of 10); look-for-mallory 0.0% (0 of 5); phreshphish 6.8% (7 of 103); samples-body 50.0% (3 of 6); scamferret 0.0% (0 of 4).

Redacted South African samples: lure recall 97.6% (40 of 41).

Independent reference set (493 pages, drawn before any teacher check): Loupe lure recall 92.3% (84 of 91), false alarms 3.7% (15 of 402); Muse Spark 61.5% (56 of 91) and 3.2% (13 of 402); bar passed.

Bar (lure recall at least Muse Spark's, false alarms at most 6 percent): passed.

### Training of Loupe 1.0

Hyperparameters: rank 8, learning rate 0.0001, batch size 8, 1 epoch; sessions ts-026d14227a0042128f9dd410c648d329; promoted checkpoint step-6503.

Trained on 52019 lines. Dataset: 52019 screenshots, 19891 brands, 217 South African; `train.jsonl` SHA-256 `e8c693be6d5a0eba4ce25ec1cc8e6d5d8585d62b32a8209a74172ada0f3adc9e`; held out 1000 lines (1000 screenshots, 467 brands, 545 South African), `eval.jsonl` SHA-256 `a23db3ab1f0abae747c6023167b5bcd67a4882002804ff639a00f01cf49716a8`.

Training lines by origin: public 48633, benign 3288, samples 98; by lure type: none 31211, impersonation 14160, credential 6127, fake shop 398, payment 123; by source: phreshphish 27747, look-for-mallory 5927, ariyadasa-2021 4547, kempf-html 4515, compphish 4211, benign-majestic 3239, scamferret 1175, 7-days-later 511, samples-body 98, benign-sa 49.

Held-out lines by origin: public 524, benign 429, samples 47; by lure type: none 600, fake shop 139, impersonation 103, credential 80, payment 78; by source: benign-sa 246, phreshphish 241, benign-majestic 183, scamferret 143, ariyadasa-2021 80, samples-body 47, compphish 22, kempf-html 21, 7-days-later 9, look-for-mallory 8.

| Source | Dataset | Licence | Licence link |
| --- | --- | --- | --- |
| 7-days-later | https://zenodo.org/records/14885725 (the public sample, `phishing-alive-measurement_sample_zenodo.tar.gz`, MD5 c7ec2fd9f59510aeba745e1b85329fdf, checked) | CC BY 4.0 | https://zenodo.org/api/records/14885725 |
| ariyadasa-2021 | https://data.mendeley.com/datasets/n96ncsr5g4/1 | CC BY 4.0 | https://data.mendeley.com/datasets/n96ncsr5g4/1 |
| benign-majestic | https://majestic.com/reports/majestic-million (top 20,576 domains, rendered by us) | CC BY 3.0 (Majestic) | https://majestic.com/reports/majestic-million |
| benign-sa | eval/glimmer/benign-sa-urls.txt (our own list, rendered by us) | own list | not applicable: IsItLegit's own |
| compphish | https://data.mendeley.com/datasets/fmbs4kp9wz/4 | CC BY 4.0 | https://data.mendeley.com/datasets/fmbs4kp9wz/4 |
| kempf-html | https://www.kaggle.com/datasets/huntingdata11/phishing-website-html-classification | CC BY-SA 3.0 | https://creativecommons.org/licenses/by-sa/3.0/ |
| look-for-mallory | https://www.kaggle.com/datasets/rmdhirr/look-for-mallory | Apache 2.0 | https://www.apache.org/licenses/LICENSE-2.0 |
| phreshphish | https://huggingface.co/datasets/phreshphish/phreshphish (train shards 000 and 001) | CC BY 4.0 | https://huggingface.co/datasets/phreshphish/phreshphish/discussions/10 |
| samples-body | private pilot-client mail, redacted before any use (D03 T04 §7) | the client's written consent for redacted training | not published: the consent is kept privately and names the client |
| scamferret | https://github.com/ScamFerret/artifact (commit 8cf8dc6) | GPL-3.0 | https://github.com/ScamFerret/artifact/blob/8cf8dc631edafe584141e2f95f0c0f51855fb7bc/LICENSE |

Tokens: 243634301 (72258021 text, 171376280 image; 2060959 trained, 241573342 prompt); a line holds 1981 to 13782 tokens (median 4659); 3294 image tokens a screenshot.

Run: 6503 steps, loss 0.725 to 0.036; wall time 14.5 hours of training, 8.02 seconds a step; 1 session, 0 resumes after interruptions; gradient norm 0.1 to 2784.0 (median 3.8); list price US$419.27; billed US$0.00 under the free fine-tuning offer (free training, operator 2026-11-01; the settled bill is checked once Fireworks has settled it).

![Training loss by step, with its axes](loupe-1.0-loss.svg) The numbers are in [the step table](loupe-1.0-loss.csv) (step, loss).

### Deployment of Loupe 1.0

Deployment: `accounts/rizonetech/deployments/isitlegit-loupe` on 1 x NVIDIA_H200_141GB, minimum 0 and maximum 1 replicas, scaling to zero after 300 idle seconds.

Warm-up: 5 cold starts measured from 0 replicas to the first answer, median 142.9 seconds, maximum 195.0 seconds; the deployment read 0 replicas 319 to 336 seconds after the last request.

Running time: 30 minutes a day on average since 2026-10-31, with one day borrowed ahead (unused minutes roll over); warm-up and the 6-minute tail after the last request are counted.

Deployment record (dated entries, oldest first):
- 2026-10-31 13:02 UTC, dedicated deployment (D03 T04 §12): `node scripts/glimmer/deploy.ts ensure 1.0` created `accounts/rizonetech/deployments/isitlegit-loupe` serving `accounts/rizonetech/models/isitlegit-loupe-1-0` (live merge, `default` shape) on 1 x NVIDIA_H200_141GB; read back minimum 0, maximum 1, scale to zero 300s, not preemptible, READY with 0 replicas at 13:10 UTC. Inference names it `accounts/rizonetech/models/isitlegit-loupe-1-0#accounts/rizonetech/deployments/isitlegit-loupe`. The held-out run's own preemptible deployment `isitlegit-loupe-eval` was created at 13:02 UTC (read back preemptible).
- 2026-10-31 13:28 UTC, key check (D03 T04 §12): `node scripts/glimmer/deploy.ts key-check 1.0` failed: the vault item "IsItLegit Fireworks", recorded as the inference-only key, was allowed a change to `isitlegit-loupe` (PATCH answered 200). The change tried was a no-op (maximum replicas 1); `status` afterwards read the same settings. The key holds more than inference rights; the fix is a key scoped to inference, which is the operator's to create (D03 T04 §12).
- 2026-10-31 13:54 UTC, key check again (D03 T04 §12), after the vault item "IsItLegit Fireworks" was narrowed to the `inference-user` role: `node scripts/glimmer/deploy.ts key-check 1.0` exit 0 (log `~/isitlegit-data/glimmer/runs/key-check-1.0-b.log`, closed 13:54:18 UTC). The one-token call answered 200 after 9 attempts and 130.7 s of cold start; the no-op change to `isitlegit-loupe` with the same key was refused 403. Recorded 14:35 UTC after the machine crash at 13:57 UTC, from the log.

### Limits of Loupe 1.0

Not trained on: Live pages that need scripts to show their content (rendered inertly, they were left out), pages behind a sign-in, and languages the public datasets hold few pages of.

- Evaluation set: The held-out evaluation set holds pages whose labels Muse Spark confirmed (the teacher-agreed set); the independent reference set was drawn before any Muse Spark check.
- Independent reference set, its 22 errors, each confirmed from its screenshot: 6 brand absent from training: the brand's own page (its site, its login, or its account on a social platform); 5 brand absent from training: a small real site with no lure, flagged for being unfamiliar; 4 wrong label?: the page shows no lure of the labelled kind; 4 wrong label?: the capture is a wall or an empty page, not the site (a capture rule should have left it out); 2 rendering: a lure drawn without its images or styles, so the copied brand does not show (a page saved without its assets); 1 brand absent from training: a real site that names a brand it is not (a news, fan or information site).
- Synthetic monitor pages (D03 T04 §1: 40 pages of ten fictional brands, 20 lures and 20 benign, none from its training; a hard test of unseen brands, not a production false-alarm estimate): lure recall 100%, false alarms 95%, median 2.3 s.
