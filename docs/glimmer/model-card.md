# Loupe model card

One part per version, made from the run's own records by `scripts/glimmer/model_card.py`.

## Loupe 1.0

`isitlegit-loupe-1-0`, a LoRA (rank 8) of Muse Glimmer 30B (accounts/fireworks/models/muse-glimmer-30b), trained by LoRA supervised fine-tuning on Fireworks' Serverless Training API (the Fireworks cookbook's SFT loop), 2026-10-30T22:20:28+00:00 to 2026-10-31T12:49:52+00:00.

Trained on 52019 lines (52019 screenshots, 19891 brands, 217 South African); held out 1000.

Hyperparameters: rank 8, learning rate 0.0001, batch size 8, 1 epoch; sessions ts-026d14227a0042128f9dd410c648d329; promoted checkpoint not recorded in run.json.

Training lines by origin: public 48633, benign 3288, samples 98; by lure type: none 31211, impersonation 14160, credential 6127, fake_shop 398, payment 123; by source: phreshphish 27747, look-for-mallory 5927, ariyadasa-2021 4547, kempf-html 4515, compphish 4211, benign-majestic 3239, scamferret 1175, 7-days-later 511, samples-body 98, benign-sa 49.

Sources (licence, link; `docs/glimmer/sources.md`): 7-days-later: CC BY 4.0, https://zenodo.org/api/records/14885725; ariyadasa-2021: CC BY 4.0, https://data.mendeley.com/datasets/n96ncsr5g4/1; benign-majestic: CC BY 3.0 (Majestic Million), https://majestic.com/reports/majestic-million; benign-sa: own list, eval/glimmer/benign-sa-urls.txt; compphish: CC BY 4.0, https://data.mendeley.com/datasets/fmbs4kp9wz/4; kempf-html: CC BY-SA 3.0, https://creativecommons.org/licenses/by-sa/3.0/; look-for-mallory: Apache 2.0, https://www.apache.org/licenses/LICENSE-2.0; phreshphish: CC BY 4.0, https://huggingface.co/datasets/phreshphish/phreshphish/discussions/10; samples-body: not recorded, not recorded; scamferret: GPL-3.0, https://github.com/ScamFerret/artifact/blob/8cf8dc631edafe584141e2f95f0c0f51855fb7bc/LICENSE.

Tokens: 243634301 (171376280 image, 2060959 trained, 241573342 prompt); a line holds 1981 to 13782 tokens (median 4659); 3294 image tokens a screenshot.

Run: 6503 steps, loss 0.725 to 0.036, 0 resumes; list price US$419.27; billed pending (Fireworks settles a run's bill about a day after it ends); 8.02 seconds a step; gradient norm 0.1 to 2784.0 (median 3.8). ![Loss by step](loupe-1.0-loss.svg)

## Where Loupe 1.0 stands

Loupe 1.0 does not yet meet the project's own standard. It ships under a time-boxed bar set for the competition deadline, not because the result is considered good enough.

The bar it was judged on: lure recall at least Muse Spark's and false alarms at most 6 percent, on the held-out evaluation set and on the independent reference set (operator, 2026-10-31). Result: passed on both sets.

- Evaluation set (1000 pages): Loupe's lure recall 98.0% (392 of 400) against Muse Spark's 94.2% (377 of 400), false alarms 5.7% (34 of 600); South African slice: lure recall 96.2% (50 of 52) against Muse Spark's 94.2% (49 of 52), false alarms 5.5% (27 of 493).
- Independent reference set, drawn before any Muse Spark check (493 pages): Loupe's lure recall 92.3% (84 of 91) against Muse Spark's 61.5% (56 of 91), false alarms 3.7% (15 of 402); South African slice not judged (0 lures, 2 benign, under the 30 each it needs).

The project's standard, set for Loupe 1.1 as the target it is built to meet: false alarms at most 2 percent, and lure recall above Muse Wonder's on the same pages. Loupe 1.0's false alarms are 5.7 percent at their highest of the two sets, so it is short of the first part; Muse Wonder's recall on these pages is not measured yet, so the second part is a target, not a comparison.

Known causes of its misses and false alarms (42 pages, each confirmed): 12 brand absent from training: the brand's own page (its site, its login, or its account on a social platform); 10 brand absent from training: a small real site with no lure, flagged for being unfamiliar; 6 wrong label?: the capture is a wall or an empty page, not the site (a capture rule should have left it out); 3 lure type underrepresented: a legitimate notice that reads like a lure; 3 brand absent from training: a real site that names a brand it is not (a news, fan or information site); 3 lure type underrepresented: a fake shop or lookalike with no copied brand page; 2 lure type underrepresented: a support-number scam posted on a legitimate host; 1 lure type underrepresented: a lure mail with no brand or link in its text; 1 wrong label?: the page shows no lure of the labelled kind; 1 lure type underrepresented: a kit page that shows only its error messages.

The work on them for Loupe 1.1: D03 T04 §25 and §27 to §29. They name what 1.1 is built to answer, not what it will reach.

| Held-out evaluation set | Loupe | Muse Spark |
| --- | --- | --- |
| lure recall | 98.0% (392 of 400) | 94.2% (377 of 400) |
| false alarm rate | 5.7% (34 of 600) | 0.2% (1 of 600) |
| accuracy | 95.8% (958 of 1000) | 97.6% (976 of 1000) |
| latency median ms | 3.9 s | 8.7 s |
| cost per page usd | not known per page | US$0.0076 |

False alarms by benign source: ariyadasa-2021 0.0% (0 of 29); benign-majestic 6.6% (12 of 183); benign-sa 4.5% (11 of 246); compphish 7.1% (1 of 14); kempf-html 0.0% (0 of 10); look-for-mallory 0.0% (0 of 5); phreshphish 6.8% (7 of 103); samples-body 50.0% (3 of 6); scamferret 0.0% (0 of 4).

Redacted South African samples: lure recall 97.6% (40 of 41).

Independent reference set (493 pages, drawn before any teacher check): Loupe lure recall 92.3% (84 of 91), false alarms 3.7% (15 of 402); Muse Spark 61.5% (56 of 91) and 3.2% (13 of 402); bar passed.

| Slice | Pages | Loupe lure recall | Muse Spark lure recall | Loupe false alarms | Muse Spark false alarms |
| --- | --- | --- | --- | --- | --- |
| South Africa | 545 (52 lures, 493 benign) | 96.2% (50 of 52) | 94.2% (49 of 52) | 5.5% (27 of 493) | 0.0% (0 of 493) |
| credential | 80 (80 lures, 0 benign) | 97.5% (78 of 80) | 91.2% (73 of 80) | n/a | n/a |
| fake_shop | 139 (139 lures, 0 benign) | 99.3% (138 of 139) | 97.1% (135 of 139) | n/a | n/a |
| impersonation | 103 (103 lures, 0 benign) | 95.1% (98 of 103) | 92.2% (95 of 103) | n/a | n/a |
| payment | 78 (78 lures, 0 benign) | 100.0% (78 of 78) | 94.9% (74 of 78) | n/a | n/a |

Evaluation set: The held-out evaluation set holds pages whose labels Muse Spark confirmed (the teacher-agreed set); the independent reference set was drawn before any Muse Spark check.

Independent reference set, its 22 errors, each confirmed from its screenshot: 6 brand absent from training: the brand's own page (its site, its login, or its account on a social platform); 5 brand absent from training: a small real site with no lure, flagged for being unfamiliar; 4 wrong label?: the page shows no lure of the labelled kind; 4 wrong label?: the capture is a wall or an empty page, not the site (a capture rule should have left it out); 2 rendering: a lure drawn without its images or styles, so the copied brand does not show (a page saved without its assets); 1 brand absent from training: a real site that names a brand it is not (a news, fan or information site).

Synthetic monitor pages (D03 T04 §1: 40 pages of ten fictional brands, 20 lures and 20 benign, none from its training; a hard test of unseen brands, not a production false-alarm estimate): lure recall 100%, false alarms 95%, median 2.3 s.

Bar (lure recall at least Muse Spark's, false alarms at most 6 percent): passed.

Deployment: 2026-10-31 13:02 UTC, dedicated deployment (D03 T04 §12): `node scripts/glimmer/deploy.ts ensure 1.0` created `accounts/rizonetech/deployments/isitlegit-loupe` serving `accounts/rizonetech/models/isitlegit-loupe-1-0` (live merge, `default` shape) on 1 x NVIDIA_H200_141GB; read back minimum 0, maximum 1, scale to zero 300s, not preemptible, READY with 0 replicas at 13:10 UTC. Inference names it `accounts/rizonetech/models/isitlegit-loupe-1-0#accounts/rizonetech/deployments/isitlegit-loupe`. The held-out run's own preemptible deployment `isitlegit-loupe-eval` was created at 13:02 UTC (read back preemptible).; 2026-10-31 13:28 UTC, key check (D03 T04 §12): `node scripts/glimmer/deploy.ts key-check 1.0` failed: the vault item "IsItLegit Fireworks", recorded as the inference-only key, was allowed a change to `isitlegit-loupe` (PATCH answered 200). The change tried was a no-op (maximum replicas 1); `status` afterwards read the same settings. The key holds more than inference rights; the fix is a key scoped to inference, which is the operator's to create (D03 T04 §12).; 2026-10-31 13:54 UTC, key check again (D03 T04 §12), after the vault item "IsItLegit Fireworks" was narrowed to the `inference-user` role: `node scripts/glimmer/deploy.ts key-check 1.0` exit 0 (log `~/isitlegit-data/glimmer/runs/key-check-1.0-b.log`, closed 13:54:18 UTC). The one-token call answered 200 after 9 attempts and 130.7 s of cold start; the no-op change to `isitlegit-loupe` with the same key was refused 403. Recorded 14:35 UTC after the machine crash at 13:57 UTC, from the log.

Warm-up: 5 cold starts measured from 0 replicas to the first answer, median 142.9 seconds, maximum 195.0 seconds; the deployment read 0 replicas 319 to 336 seconds after the last request.

Running time: 30 minutes a day on average since 2026-10-31, with one day borrowed ahead (unused minutes roll over); warm-up and the 6-minute tail after the last request are counted.

Not trained on: Live pages that need scripts to show their content (rendered inertly, they were left out), pages behind a sign-in, and languages the public datasets hold few pages of.

Intended use: Screening candidate pages for IsItLegit's impersonation monitor: a first answer on whether a page is a brand lure with a login or payment form, never the final verdict, which the evidence rules and Muse Spark decide.
