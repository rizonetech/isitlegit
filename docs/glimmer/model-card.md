# Loupe model card

One part per version, made from the run's own records by `scripts/glimmer/model_card.py`.

## Loupe 1.0

`isitlegit-loupe-1-0`, a LoRA (rank 8) of Muse Glimmer 30B (accounts/fireworks/models/muse-glimmer-30b), trained by LoRA supervised fine-tuning on Fireworks' Serverless Training API (the Fireworks cookbook's SFT loop), 2026-10-30T22:20:28+00:00 to 2026-10-31T12:49:52+00:00.

Trained on 52019 lines (52019 screenshots, 19891 brands, 217 South African); held out 1000.

Tokens: 243634301 (171376280 image, 2060959 trained).

Run: 6503 steps, loss 0.725 to 0.036, 0 resumes, rated US$419.27. ![Loss by step](loupe-1.0-loss.svg)

## Where Loupe 1.0 stands

Loupe 1.0 does not yet meet the project's own standard. It ships under a time-boxed bar set for the competition deadline, not because the result is considered good enough.

The bar it was judged on: lure recall at least Muse Spark's and false alarms at most 6 percent, on the held-out evaluation set and on the independent reference set (operator, 2026-10-31). Result: passed on both sets.

- Evaluation set (1000 pages, 400 lures, 600 benign): Loupe's lure recall 0.980 against Muse Spark's 0.943, false alarms 0.057; South African slice (52 lures, 493 benign): recall 0.962 against 0.942, false alarms 0.055.
- Independent reference set, drawn before any Muse Spark check (493 pages, 91 lures, 402 benign): Loupe's lure recall 0.923 against Muse Spark's 0.615, false alarms 0.037; South African slice not judged (0 lures, 2 benign, under the 30 each it needs).

The project's standard, set for Loupe 1.1 as the target it is built to meet: false alarms at most 2 percent, and lure recall above Muse Wonder's on the same pages. Loupe 1.0's false alarms are 5.7 percent at their highest of the two sets, so it is short of the first part; Muse Wonder's recall on these pages is not measured yet, so the second part is a target, not a comparison.

Known causes of its misses and false alarms (42 pages, each confirmed): 12 brand absent from training: the brand's own page (its site, its login, or its account on a social platform); 10 brand absent from training: a small real site with no lure, flagged for being unfamiliar; 6 wrong label?: the capture is a wall or an empty page, not the site (a capture rule should have left it out); 3 lure type underrepresented: a legitimate notice that reads like a lure; 3 brand absent from training: a real site that names a brand it is not (a news, fan or information site); 3 lure type underrepresented: a fake shop or lookalike with no copied brand page; 2 lure type underrepresented: a support-number scam posted on a legitimate host; 1 lure type underrepresented: a lure mail with no brand or link in its text; 1 wrong label?: the page shows no lure of the labelled kind; 1 lure type underrepresented: a kit page that shows only its error messages.

The work on them for Loupe 1.1: D03 T04 §25 and §27 to §29. They name what 1.1 is built to answer, not what it will reach.

| Held-out evaluation set | Loupe | Muse Spark |
| --- | --- | --- |
| lure recall | 0.980 | 0.943 |
| false alarm rate | 0.057 | 0.002 |
| accuracy | 0.958 | 0.976 |
| latency median ms | 3.9 s | 8.7 s |
| cost per page usd | not known per page | US$0.0076 |

False alarms by benign source: ariyadasa-2021 0 of 29; benign-majestic 0.066 of 183; benign-sa 0.045 of 246; compphish 0.071 of 14; kempf-html 0 of 10; look-for-mallory 0 of 5; phreshphish 0.068 of 103; samples-body 0.500 of 6; scamferret 0 of 4.

Redacted South African samples: lure recall 0.976 of 41 lures.

Independent reference set (493 pages, drawn before any teacher check): Loupe lure recall 0.923, false alarms 0.037; Muse Spark 0.615 and 0.032; bar passed.

Bar (lure recall at least Muse Spark's, false alarms at most 6 percent): passed.

Deployment: 2026-10-31 13:02 UTC, dedicated deployment (D03 T04 §12): `node scripts/glimmer/deploy.ts ensure 1.0` created `accounts/rizonetech/deployments/isitlegit-loupe` serving `accounts/rizonetech/models/isitlegit-loupe-1-0` (live merge, `default` shape) on 1 x NVIDIA_H200_141GB; read back minimum 0, maximum 1, scale to zero 300s, not preemptible, READY with 0 replicas at 13:10 UTC. Inference names it `accounts/rizonetech/models/isitlegit-loupe-1-0#accounts/rizonetech/deployments/isitlegit-loupe`. The held-out run's own preemptible deployment `isitlegit-loupe-eval` was created at 13:02 UTC (read back preemptible).; 2026-10-31 13:28 UTC, key check (D03 T04 §12): `node scripts/glimmer/deploy.ts key-check 1.0` failed: the vault item "IsItLegit Fireworks", recorded as the inference-only key, was allowed a change to `isitlegit-loupe` (PATCH answered 200). The change tried was a no-op (maximum replicas 1); `status` afterwards read the same settings. The key holds more than inference rights; the fix is a key scoped to inference, which is the operator's to create (D03 T04 §12).; 2026-10-31 13:54 UTC, key check again (D03 T04 §12), after the vault item "IsItLegit Fireworks" was narrowed to the `inference-user` role: `node scripts/glimmer/deploy.ts key-check 1.0` exit 0 (log `~/isitlegit-data/glimmer/runs/key-check-1.0-b.log`, closed 13:54:18 UTC). The one-token call answered 200 after 9 attempts and 130.7 s of cold start; the no-op change to `isitlegit-loupe` with the same key was refused 403. Recorded 14:35 UTC after the machine crash at 13:57 UTC, from the log.; 2026-10-31 14:33 UTC, after the idle window (D03 T04 §12): `deploy.ts status` read `isitlegit-loupe` READY with 0 replicas, minimum 0, maximum 1, scale to zero 300s, not preemptible, updated 13:59:31 UTC (5 min 13 s after the key check's log closed; that the update time marks the scale-down is not confirmed, so §13's scale-to-zero timing stays open).; 2026-10-31 14:34 UTC, held-out deployment deleted (D03 T04 §13): `node scripts/glimmer/deploy.ts eval-down` was refused at 14:20 UTC (Fireworks refuses a delete within an hour of the last inference request; Loupe's run sent its last about 13:33 UTC). The retry at 14:34 UTC deleted it, but Fireworks soft-deletes (the deployment still reads back, state DELETED, and a second DELETE answers 400), so `remove()` reported it still there; fixed to count DELETED as gone and never delete twice, and `eval-down` read `{"deleted":"isitlegit-loupe-eval"}` at 14:44 UTC.

Not trained on: Live pages that need scripts to show their content (rendered inertly, they were left out), pages behind a sign-in, and languages the public datasets hold few pages of.

Intended use: Screening candidate pages for IsItLegit's impersonation monitor: a first answer on whether a page is a brand lure with a login or payment form, never the final verdict, which the evidence rules and Muse Spark decide.
