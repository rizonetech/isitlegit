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

## Dataset

## Training

## Deployment

## Measurements

## Decisions
