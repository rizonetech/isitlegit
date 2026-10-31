# Loupe training record

Loupe is IsItLegit's page screener: Muse Glimmer 30B fine-tuned with a LoRA on Fireworks AI (D03 T04). This file records what the account held, what the probe proved, the dataset, every training run, the deployment, the measurements and the decisions, each with its date. Versions are Loupe 1.0, 1.1, 1.2 and on, written `isitlegit-loupe-1-0` on Fireworks (D03 T04 §11).

## Account

Checked 2026-10-28 14:14 UTC with `node scripts/fireworks-check.ts` (admin key, `GET` only), account `rizonetech`:

- models: 0
- deployments: 0
- datasets: 2, both Fireworks' onboarding samples created with the account (`onboarding-cord-receipts`, `onboarding-prompt-router`), none of ours
- supervised fine-tuning jobs: 0
- credit redemptions: 1, redeemed 2026-10-28 06:47 UTC
- rated spend 2026-10-01 to 2026-10-28 14:14 UTC: US$0.00
- credit balance: not exposed by the Fireworks API (`/credits` answers 404); the operator's US$100 partner credit (loaded 2026-10-28 09:02 SAST) is the balance of record
- base model `accounts/fireworks/models/muse-glimmer-30b`: `supportsImageInput` true, `supervisedLoraTunable` true, `enableVisionEncoderTuning` false, `trainingContextLength` 131072, not served serverless

## Probe

- 2026-10-28 14:10 UTC: `node scripts/fireworks-check.ts --probe` wrote `build/glimmer/probe.jsonl` (3 lines, one image each) and created dataset `isitlegit-probe` (HTTP 200), but the upload answered HTTP 403 "dataset uploads are temporarily disabled, please contact Fireworks AI to get access"; the signed-URL path (`:getUploadEndpoint`) answers HTTP 400 with the same message. The account reads `accountVerification: NOT_VERIFIED`. No job was started and nothing was billed. `--delete-probe` removed the empty dataset at 14:16 UTC (read back as gone). Corrected 15:13 UTC: the account is not restricted (the operator uploads in the UI); the refusal is for the key's principal, the service account `isitlegit-meta-api-admin`. Waiting on the operator for an API key of their own user (vault item "IsItLegit Fireworks Owner") or a UI upload of the probe file.
- 2026-10-28 15:20 UTC: with the operator's own key ("IsItLegit Fireworks Owner", `GET /v1/accounts/rizonetech` HTTP 200) the upload is refused the same way (HTTP 403 on `:upload`, HTTP 400 on `:getUploadEndpoint`, both "dataset uploads are temporarily disabled"), so the API refuses uploads for the account whatever the key, while the dashboard accepts them. The empty dataset was deleted (read back as gone). Next: the operator uploads `build/glimmer/probe.jsonl` in the dashboard as dataset `isitlegit-probe`, and `--probe` starts the job on it.
- 2026-10-28 15:26 UTC: the operator reports the dashboard upload is refused too. Dataset uploads are closed for the account on every path; the operator is asking Fireworks to enable them, and the Serverless Training API (examples streamed by the client, no dataset upload; Glimmer reads `supportsServerlessTraining: true`) is being checked as an alternative.

- 2026-10-28 16:13 UTC: Fireworks support (Kat, reply received 15:35 UTC) confirmed dataset uploads are closed platform-wide with no restoration date, so the probe moved to the Serverless Training API, where Fireworks' cookbook states "Muse Glimmer 30B SFT is free via UI and Serverless Training API until 11/30". `~/.venvs/fireworks/bin/python scripts/glimmer/serverless_probe.py` rendered the three probe examples with the cookbook's `muse_glimmer` renderer and Glimmer's image processor (images of 392, 522 and 1,260 tokens), and ran one cross-entropy forward and backward pass on them and on the text controls, with no optimiser step and no checkpoint.
probe session ts-28111d83258c4bd0b016571ba6d6cc22: image step loss:sum 120.10 over 2,435 tokens; text control loss:sum 48.57 over 321 tokens; 2,762 tokens sent in all
training mode: image
- Bill: pending until 2026-10-29 16:13 UTC (rated costs lag a day); SFT on Glimmer is free until 2026-11-30 by Fireworks' statement, and §11 reconciles it before the first training run.
- Bill, 2026-10-30 11:27 UTC: reconciled: US$0.00. `node scripts/fireworks-check.ts` (GET only) read the account's rated spend from 2026-10-01 to now as US$0.00 (every SERVERLESS line US$0.00), a window holding the probe session and the 19:32 UTC throughput measure, read more than 24 hours after both.
- `--delete-probe` found no managed probe resource left (16:14 UTC).
- 16:33 UTC: closing the client had not freed the sessions' slots (`ts-28111d83…` still `READY`), so both of today's sessions were deleted through `DELETE /v1/accounts/rizonetech/trainingSessions/<id>` (HTTP 200, read back `EXPIRED`); the probe now deletes its session itself.

## Dataset

- 2026-10-30 11:15 UTC, teacher coverage for Loupe 1.0 (D03 T04 §9, §10 G8): the stratified run over the frozen pages (`node scripts/glimmer/teacher-label.ts`, South African first, then the lure types in turn) checked 1,385 pages for US$10.67 and stopped where the next attempt would pass the US$20 Glimmer Spark cap; with the earlier runs, 1,714 pages are agreed: 948 benign and 766 lures (217 impersonation, 186 payment, 184 fake_shop, 179 credential), 878 South African. `teacher-label.ts check`: clean.
- 2026-10-30 21:29 UTC, Loupe 1.0 dataset (D03 T04 §10, `node scripts/glimmer/build-dataset.ts 1.0`, mode image, seed 20261101, freeze 129,892 pages): training 52,019 lines (benign 3,288, public 48,633, samples 98; lure types credential 6,127, fake_shop 398, impersonation 14,160, none 31,211, payment 123; 217 South African; 19,891 brands), sha256 e8c693be6d5a0eba4ce25ec1cc8e6d5d8585d62b32a8209a74172ada0f3adc9e; evaluation 1,000 lines (benign 429, public 524, samples 47; lure types credential 80, fake_shop 139, impersonation 103, none 600, payment 78; 545 South African; 467 brands), sha256 a23db3ab1f0abae747c6023167b5bcd67a4882002804ff639a00f01cf49716a8. Sample-derived lures: 82 received by the split, 41 in training, 41 in evaluation. Dropped: unlabelled 0, incomplete 0, disputed 233, exact 271, near 16,411, unredacted 0, capped 8,182, balanced 35,761, afterFreeze 0, excluded 1,769, namesClient 24. Reference set 500 pages (sha256 8868678f1f9c029bdb742561f59f4d203da8a131c02809a17366a44192a740b3); 4,905 groups held out. The build's read-back validated every line and scanned both files for the protected sample terms and, in sample lines, addresses, phones and long numbers: clean.
- 2026-10-29 15:37 UTC, teacher run (D03 T04 §9): Muse Spark checked 575 trusted-label pages over two runs (`node scripts/glimmer/teacher-label.ts --max 500`, then `--max 500 --retry-failed` after the first run's empty answers were traced to Spark spending its 600 output tokens on reasoning; fixed with `reasoning.effort: low` and 2,000 output tokens). Every checked page is South African, since the teacher takes those first: 346 South African benign renders, 137 redacted sample lures (Microsoft high-confidence phishing), and 92 public-set pages hosted in South Africa. Outcomes: 512 agreed, 62 disputed (left out of training and evaluation, per the 21:32 decision), 1 quarantined (its answer was lost), 0 failed. Spend measured US$6.91 across both runs (the second US$3.36), none uncertain, inside the US$20 check. Receipt `raw/teacher/receipt.json`, store snapshot 125,796 pages, manifest digest `211a3344c057460f5f5925bbfb7989c5db03258b50b837fe0ff726ee56ab04b6`; `node scripts/glimmer/teacher-label.ts check` printed `teacher-label check: clean`.
- What the disputes say: 54 of the 62 are sample lures whose `lure` is Microsoft's ground truth, which Spark called benign (54 of the 137 checked, 39 percent). Dropping them leaves 83 agreed South African sample lures for §10's splits, above the 30 evaluation and half-for-training floors §10 now enforces. They also measure the teacher itself: on Microsoft-confirmed South African lures, base Spark's recall was 61 percent, which is the bar Loupe must beat (§13). Reversing the 21:32 decision would restore the 54 pages by having a judge settle each dispute before the next build.
- Brand labels: where Spark named a brand, it agreed with a rule-filled brand on 95 pages and disagreed on 131, and with a source's own brand on 253 against 94; 19,985 lure pages still have no brand the rules could resolve. Rule brands are weak labels: they train, but §13 scores brand only where the page's own brand label is trusted (`labelTrusted()` in `scripts/glimmer/build-dataset.ts`; `rule` is not trusted), so they never enter a brand score.
- 2026-10-28 19:40 UTC, throughput measure set (D03 T04 §11): 50 lines from stored public pages, brand null where not yet labelled, trained once unpromoted only to measure tokens a second, never a Loupe version: train.jsonl sha256 40e725be3b9d1a785018c1db67e55c432e53e91b12a5f2406ee2965ca2912a53.
- 2026-10-28 19:35 UTC, label spot check `phreshphish`: 50 pages drawn with a fixed seed (20261028) from the 6,760 stored at the time, each screenshot and text viewed against its labels. 3 wrong: a page labelled phishing that is now a parked "domain for sale" page (the lure was gone when it was captured), a print-on-demand marketplace labelled phishing for TikTok (doubtful), and an Apple-store clone whose brand reads Naver: 6 percent, under the 10 percent line, so the labels stay `ground-truth`.
- 2026-10-28 18:50 UTC, label spot check `scamferret`: 50 pages drawn with a fixed seed (20261028) from the 2,349 stored, each screenshot viewed against its `lure` and `lure_type`. No label was clearly wrong; 2 were doubtful (a Dutch crypto-trading course and a Russian cloud-mining service, both from the dataset's legitimate investment category), counted as errors: 4 percent, under the 10 percent line, so the source's labels stay `ground-truth`. The check also found one Shift_JIS page stored as mojibake, which led to `decodeHtml()` and a clean reimport of the source (commit 2d2a94e). Renders of dataset HTML carry no styles or images (the renderer fetches nothing), and some show a cookie banner the page drew itself.

## Training

- 2026-10-28 19:32 to 19:34 UTC, throughput measure (unpromoted, `runs/loupe-1.0-measure`): 50 lines in 7 steps of 8, 58,143 tokens as the trainer counts them (about 1,160 a line), 1,066 to 1,212 tokens a second once warm, loss 0.880 to 0.047; about 3,400 lines an hour, so 24 hours of training holds about 80,000 lines and 40 hours about 135,000. Rated US$0.34 if billed.
- 2026-10-29 correction to the 19:32 UTC measure: the trainer's `train/total_tokens` counts text tokens only (a real line is about 788 text and 3,312 image tokens by Glimmer's renderer), so its tokens a second do not size the set. By wall time, steps 2 to 6 trained 40 lines in 34.9 seconds, about 1.15 lines a second (about 4,100 lines an hour) once warm; 50 lines took 69.7 seconds with the first step's warm-up. `train_serverless.py --lines-per-second` sizes the set from this.
- Loupe 1.0: isitlegit-loupe-1-0, set 52019 of 52019 lines (243634301 tokens, seed 20261101, cap lifted), dataset e8c693be6d5a0eba4ce25ec1cc8e6d5d8585d62b32a8209a74172ada0f3adc9e
- Loupe 1.0: isitlegit-loupe-1-0, trained 2026-10-30, dataset e8c693be6d5a0eba4ce25ec1cc8e6d5d8585d62b32a8209a74172ada0f3adc9e, job ts-026d14227a0042128f9dd410c648d329
- Loupe 1.0 step 50: loss 0.029872754192271506, 543177 tokens sent, rated US$3.18
- Loupe 1.0 step 100: loss 0.07222907683528788, 1096264 tokens sent, rated US$6.42
- Loupe 1.0 step 150: loss 0.06353033982888283, 1682865 tokens sent, rated US$9.86
- Loupe 1.0 step 200: loss 0.01914608791135656, 2209044 tokens sent, rated US$12.95
- Loupe 1.0 step 250: loss 0.023938123991309544, 2772004 tokens sent, rated US$16.24
- Loupe 1.0 step 300: loss 0.011646355935244454, 3312890 tokens sent, rated US$19.41
- Loupe 1.0 step 350: loss 0.016992510839459584, 3867137 tokens sent, rated US$22.66
- Loupe 1.0 step 400: loss 0.09464618100940157, 4398830 tokens sent, rated US$25.78
- Loupe 1.0 step 450: loss 0.04212108971304133, 4961977 tokens sent, rated US$29.08
- Loupe 1.0 step 500: loss 0.04251011228188872, 5500035 tokens sent, rated US$32.23
- Loupe 1.0 step 550: loss 0.03455393049227613, 6067400 tokens sent, rated US$35.55
- Loupe 1.0 step 600: loss 0.011081792269698259, 6622476 tokens sent, rated US$38.81
- Loupe 1.0 step 650: loss 0.026039126323061268, 7162800 tokens sent, rated US$41.97
- Loupe 1.0 step 700: loss 0.02271345154042982, 7702727 tokens sent, rated US$45.14
- Loupe 1.0 step 750: loss 0.0141520330425331, 8262590 tokens sent, rated US$48.42
- Loupe 1.0 step 800: loss 0.0211823350831409, 8817441 tokens sent, rated US$51.67
- Loupe 1.0 step 850: loss 0.03024957148736326, 9368280 tokens sent, rated US$54.90
- Loupe 1.0 step 900: loss 0.02104645672955488, 9926447 tokens sent, rated US$58.17
- Loupe 1.0 step 950: loss 0.00993684547547934, 10490431 tokens sent, rated US$61.47
- Loupe 1.0 step 1000: loss 0.0330281950014274, 11025766 tokens sent, rated US$64.61
- Loupe 1.0 step 1050: loss 0.013502402343654617, 11595478 tokens sent, rated US$67.95
- Loupe 1.0 step 1100: loss 0.03023607772826437, 12147401 tokens sent, rated US$71.18
- Loupe 1.0 step 1150: loss 0.014710191530217024, 12728880 tokens sent, rated US$74.59
- Loupe 1.0 step 1200: loss 0.004343050276966042, 13293062 tokens sent, rated US$77.90
- Loupe 1.0 step 1250: loss 0.006399065043207123, 13831750 tokens sent, rated US$81.05
- Loupe 1.0 step 1300: loss 0.01616423178749222, 14361289 tokens sent, rated US$84.16
- Loupe 1.0 step 1350: loss 0.010033622670241675, 14892192 tokens sent, rated US$87.27
- Loupe 1.0 step 1400: loss 0.018787266216176116, 15420854 tokens sent, rated US$90.37
- Loupe 1.0 step 1450: loss 0.01104736257761374, 16018808 tokens sent, rated US$93.87
- Loupe 1.0 step 1500: loss 0.012501088759736852, 16576349 tokens sent, rated US$97.14
- Loupe 1.0 step 1550: loss 0.013647275894084118, 17141294 tokens sent, rated US$100.45
- Loupe 1.0 step 1600: loss 0.012181692655347786, 17691726 tokens sent, rated US$103.67
- Loupe 1.0 step 1650: loss 0.016809876204033694, 18262293 tokens sent, rated US$107.02
- Loupe 1.0 step 1700: loss 0.01901785396586224, 18807038 tokens sent, rated US$110.21
- Loupe 1.0 step 1750: loss 0.04455829786055305, 19360885 tokens sent, rated US$113.45
- Loupe 1.0 step 1800: loss 0.03909713234998299, 19879615 tokens sent, rated US$116.49
- Loupe 1.0 step 1850: loss 0.021485821418063673, 20428069 tokens sent, rated US$119.71
- Loupe 1.0 step 1900: loss 0.004623465494439512, 20986851 tokens sent, rated US$122.98
- Loupe 1.0 step 1950: loss 0.008479939214270817, 21539314 tokens sent, rated US$126.22
- Loupe 1.0 step 2000: loss 0.00397881219500551, 22050873 tokens sent, rated US$129.22
- Loupe 1.0 step 2050: loss 0.01823160911284256, 22609685 tokens sent, rated US$132.49
- Loupe 1.0 step 2100: loss 0.008367539352160502, 23166164 tokens sent, rated US$135.75
- Loupe 1.0 step 2150: loss 0.06829739962501769, 23713858 tokens sent, rated US$138.96
- Loupe 1.0 step 2200: loss 0.017058917055853755, 24261351 tokens sent, rated US$142.17
- Loupe 1.0 step 2250: loss 0.014135324975171231, 24817562 tokens sent, rated US$145.43
- Loupe 1.0 step 2300: loss 0.009237838925094022, 25383936 tokens sent, rated US$148.75
- Loupe 1.0 step 2350: loss 0.027198693789549325, 25907305 tokens sent, rated US$151.82
- Loupe 1.0 step 2400: loss 0.026992102165477937, 26434655 tokens sent, rated US$154.91
- Loupe 1.0 step 2450: loss 0.021553577053339764, 26968548 tokens sent, rated US$158.04
- Loupe 1.0 step 2500: loss 0.02932941345966365, 27515221 tokens sent, rated US$161.24
- Loupe 1.0 step 2550: loss 0.013320228111752912, 28066191 tokens sent, rated US$164.47
- Loupe 1.0 step 2600: loss 0.008044679322691177, 28592270 tokens sent, rated US$167.55
- Loupe 1.0 step 2650: loss 0.013352251420391656, 29147622 tokens sent, rated US$170.81
- Loupe 1.0 step 2700: loss 0.009089384246141866, 29685675 tokens sent, rated US$173.96
- Loupe 1.0 step 2750: loss 0.005829440327410172, 30241123 tokens sent, rated US$177.21
- Loupe 1.0 step 2800: loss 0.013732075139236164, 30792526 tokens sent, rated US$180.44
- Loupe 1.0 step 2850: loss 0.011319971381270175, 31347566 tokens sent, rated US$183.70
- Loupe 1.0 step 2900: loss 0.013801301459475812, 31906441 tokens sent, rated US$186.97
- Loupe 1.0 step 2950: loss 0.02192070088538832, 32454779 tokens sent, rated US$190.19
- Loupe 1.0 step 3000: loss 0.015384664258453699, 33011550 tokens sent, rated US$193.45
- Loupe 1.0 step 3050: loss 0.0021341889995507395, 33568435 tokens sent, rated US$196.71
- Loupe 1.0 step 3100: loss 0.014042404191679155, 34157719 tokens sent, rated US$200.16
- Loupe 1.0 step 3150: loss 0.019939993959544197, 34721398 tokens sent, rated US$203.47
- Loupe 1.0 step 3200: loss 0.02050941841297285, 35262597 tokens sent, rated US$206.64
- Loupe 1.0 step 3250: loss 0.004671715391587468, 35818645 tokens sent, rated US$209.90
- Loupe 1.0 step 3300: loss 0.01375994694149628, 36337968 tokens sent, rated US$212.94
- Loupe 1.0 step 3350: loss 0.013198315864250064, 36880605 tokens sent, rated US$216.12
- Loupe 1.0 step 3400: loss 0.0025823239382851415, 37424545 tokens sent, rated US$219.31
- Loupe 1.0 step 3450: loss 0.04297495201356917, 37963297 tokens sent, rated US$222.46
- Loupe 1.0 step 3500: loss 0.01542483077229318, 38487436 tokens sent, rated US$225.54
- Loupe 1.0 step 3550: loss 0.00417275587671231, 39040321 tokens sent, rated US$228.78
- Loupe 1.0 step 3600: loss 0.00862236868725587, 39590364 tokens sent, rated US$232.00
- Loupe 1.0 step 3650: loss 0.01720807277279625, 40133973 tokens sent, rated US$235.19
- Loupe 1.0 step 3700: loss 0.024944890378644252, 40675184 tokens sent, rated US$238.36
- Loupe 1.0 step 3750: loss 0.020919622965425096, 41248418 tokens sent, rated US$241.72
- Loupe 1.0 step 3800: loss 0.026613055359225903, 41818515 tokens sent, rated US$245.06
- Loupe 1.0 step 3850: loss 0.011168698887250812, 42356980 tokens sent, rated US$248.21
- Loupe 1.0 step 3900: loss 0.011008546660956724, 42921762 tokens sent, rated US$251.52
- Loupe 1.0 step 3950: loss 0.021416122577622227, 43460826 tokens sent, rated US$254.68
- Loupe 1.0 step 4000: loss 0.017118707178936692, 43994929 tokens sent, rated US$257.81
- Loupe 1.0 step 4050: loss 0.034094663963901206, 44558010 tokens sent, rated US$261.11
- Loupe 1.0 step 4100: loss 0.014382582762333292, 45099635 tokens sent, rated US$264.28
- Loupe 1.0 step 4150: loss 0.025790907954909337, 45659983 tokens sent, rated US$267.57
- Loupe 1.0 step 4200: loss 0.012924737672381538, 46204796 tokens sent, rated US$270.76
- Loupe 1.0 step 4250: loss 0.01043193327252941, 46768605 tokens sent, rated US$274.06
- Loupe 1.0 step 4300: loss 0.020410880514705396, 47309823 tokens sent, rated US$277.24
- Loupe 1.0 step 4350: loss 0.008824181115859827, 47871928 tokens sent, rated US$280.53
- Loupe 1.0 step 4400: loss 0.008013132148799293, 48404218 tokens sent, rated US$283.65
- Loupe 1.0 step 4450: loss 0.024482194055836286, 48951286 tokens sent, rated US$286.85
- Loupe 1.0 step 4500: loss 0.016418930179608736, 49496239 tokens sent, rated US$290.05
- Loupe 1.0 step 4550: loss 0.012423688267421316, 50090550 tokens sent, rated US$293.53
- Loupe 1.0 step 4600: loss 0.014368203128153435, 50625859 tokens sent, rated US$296.67
- Loupe 1.0 step 4650: loss 0.003016936484173927, 51182625 tokens sent, rated US$299.93
- Loupe 1.0 step 4700: loss 0.004736192493123844, 51751602 tokens sent, rated US$303.26
- Loupe 1.0 step 4750: loss 0.03779451837654412, 52303882 tokens sent, rated US$306.50
- Loupe 1.0 step 4800: loss 0.004640829280731898, 52847865 tokens sent, rated US$309.69
- Loupe 1.0 step 4850: loss 0.01641897205793549, 53391087 tokens sent, rated US$312.87
- Loupe 1.0 step 4900: loss 0.01573325670319225, 53927832 tokens sent, rated US$316.02
- Loupe 1.0 step 4950: loss 0.02074741623788944, 54473805 tokens sent, rated US$319.22
- Loupe 1.0 step 5000: loss 0.027237283357407292, 55053156 tokens sent, rated US$322.61
- Loupe 1.0 step 5050: loss 0.020069271649943037, 55610317 tokens sent, rated US$325.88
- Loupe 1.0 step 5100: loss 0.044557810703381266, 56199894 tokens sent, rated US$329.33
- Loupe 1.0 step 5150: loss 0.009410079150255827, 56759274 tokens sent, rated US$332.61

## Deployment

## Measurements

## Decisions

- 2026-10-29 20:23 SAST, operator: the widened Majestic render (D03 T04 §18) runs 6 pages at a time instead of 4, to finish sooner (about 14,000 renders were left at 1,170 an hour at 4). §26 proved the batch at 4; the render receipt records each run's width, and its exclusions by reason show whether the wider run met more bot walls or timeouts. Reversing it means stopping the run and resuming it with `--concurrency 4`; nothing is lost, since the journal resumes every URL.

- 2026-10-28, D03 T04 §6 (plan review finding 1), recorded 2026-10-29: the benign pages are our own renders of public web pages (the Majestic Million's top domains under CC BY 3.0 and our own South African list), rendered by `scripts/glimmer/render.ts` from known-good URLs. They are used only to train and evaluate Loupe, kept in the private store at `~/isitlegit-data/glimmer`, and never published or redistributed: no page, screenshot or text from them goes into the repository, a release, a model card or a dataset share. A page's owner keeps every right in it; we keep the render for training alone. Changing this basis (publishing them, sharing them, or using them for anything but training and evaluation) means dropping the benign renders from the store and every dataset built from them.

- 2026-10-28 21:41 SAST, operator: D03 T04 §8 (synthetic South African lures) is removed, since Claude will not generate realistic lure pages impersonating real brands. Microsoft's high-confidence phishing verdict on the redacted pilot-client mail counts as ground truth (155 lure pages after duplicates) and gives evaluation its South African lures; a plain phishing verdict stays `unverified` (105 pages, trained on, never evaluated). Reversing it means a source of real South African lure pages with known labels.

- 2026-10-28 21:36 SAST, operator: quality matters as much as quantity, low false positives and high detection alike. Each Loupe version aims at more training lines, better labels, fewer false alarms and more detections than the one before; a version is promoted only when, on the same held-out set, it trained on more lines, its lure recall is at least the previous version's and its false-alarm rate no higher, overall and on the South African slice (D03 T04 §13). Rule labels (§9) add lines; the held-out set, which holds trusted labels only, is what shows whether they cost quality.

- 2026-10-28 21:32 SAST, operator: the human checks are dropped to save time (D03 T04 §9, §18): no Astra or Claude judging of queued pages, no 200-page check by eye, no spot check of the second sweep's sources. A page whose `lure` the teacher disputes is left out of training and evaluation; an `unverified` page trains at confidence 0.7 and never enters evaluation; the §5 spot checks (ScamFerret 4 percent, PhreshPhish 6 percent) stand as the recorded label error rates. Reversing it means running both judges over the queue and checking a sample before the next build.

- 2026-10-28 20:50 SAST, operator: the US$60 a-run training cap is lifted until 2026-11-30 23:59 SAST, while Glimmer's supervised fine-tuning is free, and applies again from 2026-12-01 by the date in `scripts/glimmer/train_serverless.py` (D03 T04 §11). The lift holds only once the probe's 24-hour bill reconciliation reads US$0 rated for training; until then, or if it reads more, US$60 stands. Reversing it costs nothing: the cap returns by date. With the cap lifted, the time left before 2026-11-01 12:00 SAST bounds the training set instead.
- 2026-10-28 20:50 SAST, operator: many more public sources go into Loupe 1.0 rather than a later 1.1 (D03 T04 §18): a second Astra sweep aimed at lures, ten more PhreshPhish shards, the 7 Days Later sample and the Majestic Million's top 20,000.
