---
schema_version: 1
id: glimmer
domain: 03-vision
status: active
title: "TODO-04 -- Page Screening on Muse Glimmer with Muse Spark Failover"
track: day-6
---

# TODO-04 -- Page Screening on Muse Glimmer with Muse Spark Failover

> **Goal:** The impersonation monitor screens candidate pages through one `screenPage` interface: a Muse Glimmer 30B LoRA fine-tuned for this job on Fireworks AI (free supervised fine-tuning of Glimmer until 2026-11-30), served from a dedicated Fireworks deployment that scales to zero after 5 idle minutes and runs at most 30 minutes a day, with its warm-up counted against that budget, and Muse Spark in Standard mode on the Meta Model API (`store: false`, the Meta client and AI Gateway) whenever the deployment is warming past its limit, out of daily minutes, failing, timing out or over its cap, so the monitor never stops. The training set is built as large as quality allows from public phishing-page datasets (licence-checked), real benign pages rendered locally, the redacted sample mail in `samples/` (consent extended 2026-10-28) and synthetic South African lures. **Corrected 2026-10-28 (operator decisions, 15:01 to 15:16 SAST):** the screener is a fine-tuned Glimmer on a dedicated deployment instead of base Glimmer on serverless (Glimmer is not served pay-per-token, checked 11:33 SAST, and fine-tuned LoRAs never run on serverless); the 30-minute daily limit, 5-minute scale to zero and warm-up handling are the operator's; the pilot client's consent is extended so redacted sample content may go into training lines on Fireworks (`samples/pilot-consent.md`, local); Astra (GPT-6 Astra through the Codex CLI) also collects public datasets outside the repository, Claude writes every guide and script and verifies what Astra collects, and Astra keeps reviewing Claude's code; general cyber security training is out of scope. The earlier Goal (09:05 SAST), kept for the record: Muse Glimmer 30B on Fireworks AI serverless first (through AI Gateway; the chat completions endpoint, which keeps no prompt or output data for open models, never the Responses API, which keeps conversations 30 days), and Muse Spark in Standard mode whenever Fireworks fails, times out, rate-limits or reaches its cap; Glimmer at US$0.35 and US$1.50 a million input and output tokens. **Corrected 2026-10-28 (operator decision, 09:05 SAST):** Fireworks' US$100 partner credit is loaded, so the 2026-10-27 removal is reversed and Glimmer on Fireworks is the screener again, with Spark (the 2026-10-27 screener) as its failover. Lookalike pages copy real people's details, the reason the Contributor plan was withdrawn. The Goal before that: one `screenPage` interface on Muse Spark (Standard mode, `store: false`), about US$0.005 a page. **Corrected 2026-10-27 (operator decisions):** this file planned Muse Glimmer through a hosted provider (Fireworks, then Baseten); at 10:47 SAST the operator removed the outside providers in favour of Muse Spark 1.3 Contributor, and at 11:05 SAST chose Standard Muse Spark instead, because lookalike pages copy real people's names, addresses and numbers and Meta forbids personal data in Contributor input. The rule "Standard model IDs only, never `-contributor`" (`AGENTS.md`) stands unchanged.

> **Current state:** Measured 2026-10-28 15:20 SAST. No screening, dataset or training code exists. The Meta Model API key is in the vault ("IsItLegit Meta Model API"); calls go through AI Gateway `isitlegit` (D00 T01 §6, which has a `custom-meta` route). Fireworks' US$100 credit is loaded (operator, 09:02 SAST); the vault items "IsItLegit Fireworks" (an inference-only service account's key, the Worker's `FIREWORKS_API_KEY`) and "IsItLegit Fireworks Admin" (local scripts only, never a Worker secret) both have filled credentials (checked 11:33 SAST, each lists 29 models with HTTP 200). Glimmer is not served pay-per-token (`accounts/fireworks/models/muse-glimmer-30b` answers 404 and is absent from `/inference/v1/models`), so it runs only on a dedicated deployment. Researched 2026-10-28 from Fireworks' documentation: Glimmer 30B supervised fine-tuning (LoRA) is free through the UI and the Serverless Training API until 2026-11-30; fine-tuned LoRAs deploy only to dedicated deployments, and a single LoRA is best served by live merge; `scale-to-zero-window` defaults to 1h with a 5m minimum, `min-replica-count` 0 enables it; a request to a scaled-to-zero deployment gets an immediate HTTP 503 `DEPLOYMENT_SCALING_UP` and is not queued, and warm-up is "up to a few minutes" (no number given); billing is per GPU second while replicas are active with no start-up charge, H100 80 GB at US$8.00/h (30 minutes a day is US$4.00); there is no platform setting for a daily runtime cap; deployments with zero minimum replicas are deleted after 7 days without traffic; training data is JSONL in OpenAI chat format with base64 images in `user` messages, 3 to 3 million lines, training context 32,768 tokens by default; whether Glimmer's free SFT accepts images is not documented (§2 proves it). `samples/` (git-ignored except `README.md` and `.gitignore`) holds 543 `.eml` files: 533 from the pilot client's Defender quarantine in its own subfolder (Microsoft verdict in each filename; the subfolder is named only in the git-ignored `samples/NOTES.md`) and the operator's own mail in `samples/gmail/` and `samples/outlook/`, labelled in `samples/manifest.csv`; The pilot client's consent (`samples/pilot-consent.md`) covers the Meta Model API and, since 2026-10-28 15:16 SAST, redacted content in Fireworks training lines. `playwright-core` 1.64.1 is a dev dependency and `test/node/browser.ts` exports `chromiumPath()`. History: on 2026-10-27 the Fireworks account had no credit and Baseten's covered only Muse Spark Open; neither was used.

## Inputs

- Design spec 4.8 (Meta data terms: Standard model IDs only), 4.9 (licences of public corpora), 4.11 (monitor screening), 9 (model map), 11 (budget: Fireworks US$90 in total and US$5 a day; Meta US$120 total and US$15 a day).
- Fireworks AI documentation: free Glimmer training (https://fireworks.ai/blog/train-muse-glimmer-for-free, https://fireworks.ai/pricing), deploying LoRAs (https://docs.fireworks.ai/fine-tuning/deploying-loras), autoscaling (https://docs.fireworks.ai/deployments/autoscaling), deployment management (https://docs.fireworks.ai/api-reference/training-sdk/deployment-management), vision fine-tuning data format (https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm), on-demand billing (https://docs.fireworks.ai/faq-new/deployment-infrastructure/how-does-billing-work-for-on-demand-deployments), the Muse Glimmer 30B model page (https://fireworks.ai/models/fireworks/muse-glimmer-30b).
- `samples/README.md` and the local `samples/pilot-consent.md` (consent terms for the sample mail).
- -> XREF: D08 T01 §2 -- the licence rule for public corpora that §5 applies to page datasets
- -> XREF: D05 T04 §2 -- the daily monitor run that calls §15's `wakeGlimmer` at its start

## Outcome

- A fine-tuned Glimmer model on Fireworks, trained free on a deduplicated, seed-disjoint dataset whose sources, licences and counts are recorded in `docs/glimmer/sources.md` and `docs/glimmer/training.md`.
- A dedicated deployment that scales to zero 5 minutes after its last request, whose measured warm-up is recorded, and whose daily running time IsItLegit holds to 30 minutes.
- `screenPage(screenshot, text, ctx)` returns a structured "brand lure with login or payment form" judgement from the tuned Glimmer, or from Muse Spark when Glimmer cannot answer in time or within its minutes, naming which answered and why, with its cost recorded against the monitor run that asked.
- `docs/frontier-log.md` records the tuned Glimmer's and Spark's accuracy, misses, latency and cost per page on the held-out set, side by side.

**Adjacency:** all=not-applicable (internal screening step for the monitor; results are shown through monitor findings, D05 T04 §5)

**Adjacency rationale:** Screening only feeds the monitor pipeline; the training and deployment scripts are local operator tooling with no product surface.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §2 | Fireworks account check and image probe | -- | [ ] |
| 2 | §3 | PageScreen contract and training store | -- | [ ] |
| 3 | §4 | Astra as dataset collector | -- | [x] |
| 4 | §5 | Public phishing-page datasets by licence | §3, §4 | [ ] |
| 5 | §6 | Benign real pages rendered locally | §3 | [ ] |
| 6 | §7 | Redacted sample mail converted to pages | §3, §6 | [ ] |
| 7 | §8 | Synthetic South African lures | §6, §7 | [ ] |
| 8 | §9 | Spark teacher labels and human check | §5, §6, §7, §8 | [ ] |
| 9 | §10 | Deduplicated seed-disjoint training set | §2, §9 | [ ] |
| 10 | §11 | Free SFT job on Muse Glimmer 30B | §10 | [ ] |
| 11 | §12 | Deployment with 5-minute scale to zero | §11 | [ ] |
| 12 | §13 | Warm-up and held-out accuracy measured | §12 | [ ] |
| 13 | §14 | Daily 30-minute runtime ledger | §12, D03 T01 §2 | [ ] |
| 14 | §15 | Warm-up handling and wake call | §14 | [ ] |
| 15 | §1 | Glimmer screener, Spark failover | D03 T02 §3, §13, §15 | [ ] |
| 16 | §16 | Resumable verified dataset downloads | §4 | [ ] |

## 1. Glimmer screener, Spark failover

One screening interface for the monitor: it gets the page screenshot and visible text (untrusted) and answers whether the page is a brand lure with a login or payment form, on the fine-tuned Glimmer deployment first and Muse Spark on the Meta Model API when Glimmer cannot answer. **Corrected 2026-10-28 (operator decisions, 15:01 to 15:16 SAST):** Glimmer is the fine-tuned model on its dedicated deployment (§11, §12), not base Glimmer on serverless; the account check moved to §2, the `PageScreen` schema and prompt to §3, the token-priced cap to the minutes ledger (§14), and warm-up handling to §15; `third-party` is removed because both Fireworks vault items are filled (checked 11:33 SAST) and the operator decided on the dedicated deployment. **Corrected 2026-10-28 (operator decision, 09:05 SAST):** was "Page screener on Muse Spark", Spark alone. **Corrected 2026-10-27:** was §2, beside a Glimmer client (§1) and a Glimmer comparison (§3), both removed with the outside providers; the screening happens before any case exists, so its cost belongs to the monitor run.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Route the deployment through AI Gateway. Done when: a gateway call to the tuned model returns.
2. Write `screenPage` on the tuned Glimmer, failing over to Spark. Done when: stubbed tests cover Glimmer's answer and each failover cause.
3. Measure both on 40 synthetic pages. Done when: `docs/frontier-log.md` has a tuned Glimmer row and a Spark row for the set.

- [ ] Add a `custom-fireworks` provider route to AI Gateway `isitlegit` next to `custom-meta` (D00 T01 §6), and put `FIREWORKS_API_KEY` as a Wrangler secret from the vault item "IsItLegit Fireworks" (never printed). Done when: the gateway config test (`test/node/gateway-config.test.ts`) lists the route and a live one-token call to the deployment named in `docs/glimmer/training.md` returns through it, its cost logged. Cheaper substitute: calling `api.fireworks.ai` directly, outside the gateway's logs.
- [ ] Write `screenPage(image, text, ctx)` in `src/vision/screen.ts` on the `PageScreen` schema and `SCREENER_SYSTEM_PROMPT` from `src/vision/page-screen.ts` (§3), sending the request exactly as `buildScreenRequest` builds it for training: the tuned model through the Fireworks chat completions endpoint (never the Responses API) with a JSON schema response format, the text in an untrusted block, and `ctx` naming the monitor run and the candidate host so cost and gateway metadata belong to that run, not a case (D03 T01 §3). Done when: `test/vision/screen.test.ts` passes with a stubbed Glimmer transport, finds the run and host on the call, proves the request body equals `buildScreenRequest`'s, and refuses an answer that does not fit the schema.
- [ ] Fail over to `muse-spark-1.3` through `metaResponses` (D03 T01 §1) when the Glimmer call errors, times out (10 seconds once warm), returns an answer outside the schema, is refused by the minutes ledger (§14), is still warming past the limit or finds the deployment missing (§15), recording which screener answered and why the first did not. Done when: the test makes each of those happen and gets Spark's judgement with the reason, and a run with both failing returns a typed failure the monitor records rather than a guess.
- [ ] Build 40 synthetic candidate pages (20 lures with fictional brands, 20 benign) under `eval/sets/monitor-pages/`, none of them drawn from the training data store. Done when: the set and labels exist and `test/eval/monitor-pages.test.ts` finds no screenshot hash shared with `docs/glimmer/training.md`'s recorded hash list.
- [ ] Screen the set with the tuned Glimmer and with Spark, recording each one's accuracy, misses, latency and cost per page in `docs/frontier-log.md`. Done when: both rows exist; Glimmer stays the screener whatever the result (operator, 2026-10-28 15:26 SAST), and a lure recall below Spark's is recorded and answered by a retraining pass (§10, §11) finished before 2026-11-02 00:00 SAST, never by switching screeners.
- [ ] Commit: `vision: page screener on the tuned Glimmer with Muse Spark failover`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and fails if Glimmer's failure, a ledger refusal or a missing deployment is not answered by Spark, and `grep -cE 'Glimmer|Spark' docs/frontier-log.md` prints at least `2`.

## 2. Fireworks account check and image probe

> **Started:** 2026-10-28T14:12:00Z

Before any data is built, prove what the account can do: list models, deployments and credit with the admin key, and run the smallest possible free training job with images to learn whether Glimmer's free SFT accepts screenshots. The answer decides whether training lines carry the screenshot or only host, text and form structure. **Corrected 2026-10-28 (checked against the live API, 14:05 UTC):** Fireworks exposes no credit balance: `GET /v1/accounts/rizonetech/credits` answers 404 and the documented calls are credit redemptions (`creditRedemptions`, one, redeemed 2026-10-28 06:47 UTC) and rated spend (`billing/summary`, `billingUsage`), so the check lists those instead of a balance, and the operator's US$100 stays the balance of record. The account ID is `rizonetech` (`GET /v1/accounts`). The Glimmer resource reads `supportsImageInput: true`, `supervisedLoraTunable: true`, `enableVisionEncoderTuning: false` and `trainingContextLength` 131072, so the probe still decides whether image lines train. The probe needs a status and a clean-up mode, which the first draft left to hand calls.

**Blocked 2026-10-28 (14:16 UTC):** Fireworks refuses dataset uploads for account `rizonetech`: `POST /datasets/isitlegit-probe:upload` answers HTTP 403 and `:getUploadEndpoint` HTTP 400, both "dataset uploads are temporarily disabled, please contact Fireworks AI to get access"; the account reads `accountVerification: NOT_VERIFIED`. The operator verifies the account or asks Fireworks to enable uploads, records the answer here, and removes `operator` from Needs; §11's training upload waits on the same switch.

**Phase:** 0
**Needs:** operator
**Surface:** no

**Build order:**

1. Write `scripts/fireworks-check.ts`. Done when: it prints models, deployments, datasets, jobs, credit redemptions and rated spend without creating anything.
2. Run a 3-example image SFT job on Glimmer (and the text control when images are refused), then delete what it made. Done when: `docs/glimmer/training.md` records the training mode from a completed job, each job's id and its bill state, and the account holds no probe resource.

- [x] Write `scripts/fireworks-check.ts` reading the admin key from the vault item "IsItLegit Fireworks Admin" through `conclave-op` (never printed, the pattern in `scripts/meta-smoke.ts`), listing the account's models, deployments, datasets, supervised fine-tuning jobs, credit redemptions and this month's rated spend by category (`billing/summary`). Done when: `node scripts/fireworks-check.ts` prints the six lists and `test/node/fireworks-check.test.ts` shows the default mode only issues `GET` requests and that the key never appears in its output. Source: Fireworks REST API under `https://api.fireworks.ai/v1/accounts/rizonetech`, https://docs.fireworks.ai/accounts/exporting-usage-and-costs. **Corrected 2026-10-28:** was "models, deployments and credit balance"; no balance call exists.
- [x] Create `docs/glimmer/training.md` with sections `Account`, `Probe`, `Dataset`, `Training`, `Deployment`, `Measurements` and `Decisions`, and record the check's output (model, deployment, dataset and job counts, the credit redemption's date, the month's rated spend, and the operator's US$100 as the balance of record) under `Account`. Done when: the file exists with those headings and the spend figure. Cheaper substitute: keeping the numbers in chat.
- [x] Make three probe lines in `build/glimmer/probe.jsonl` from our own fixture images (`code-card.png`, `logo-card.png` and `continue-page.png` in `test/fixtures/meta-smoke/`), each a `user` message with an `image_url` base64 part and an `assistant` answer drawn from `fixtures.json`, written by `probeLines()` in `scripts/fireworks-check.ts`. Done when: the test shows 3 lines that parse as JSON with one image part each. Source: https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm. **Corrected 2026-10-28:** was one meta-smoke image and two new fixtures; the three meta-smoke cards are already our own images with known answers.
- [ ] Add a `--probe` mode to `scripts/fireworks-check.ts` that uploads `build/glimmer/probe.jsonl` as dataset `isitlegit-probe` and starts one SFT job on `accounts/fireworks/models/muse-glimmer-30b` with job ID `isitlegit-probe` (the `supervisedFineTuningJobId` query parameter; without it Fireworks makes a random ID) and output model `isitlegit-probe`, one epoch, refusing to run on or after 2026-12-01 (the free offer ends 2026-11-30) or when a probe resource already exists, and failing unless the returned job name is `accounts/rizonetech/supervisedFineTuningJobs/isitlegit-probe`. Done when: the job id is printed and `test/node/fireworks-check.test.ts` proves the date refusal, the existing-probe refusal, the requests' bodies and the refusal of a job returned under another name. Source: https://docs.fireworks.ai/api-reference/create-supervised-fine-tuning-job
- [x] Add `--probe text`, the control probe: the same three questions with the image replaced by a text description of it (`probeLines('text')`), under the names `isitlegit-probe-text`, run only when the image probe was refused for its images. Done when: the test shows the control's lines carry no image part and its requests use only the `-text` names.
- [x] Add a `--job <id>` mode printing one job's state, status message, `estimatedCost` and its outcome from `probeOutcome()`: `completed` for `JOB_STATE_COMPLETED`; `image-refused` for a failed job or dataset whose message names images (`image`, `vision`, `multimodal`); `unresolved` with the message for any other failure (authentication, quota, outage, a malformed line), which decides no training mode and is rerun after its cause is fixed; `running` otherwise. Done when: the test covers each outcome with `GET` requests only.
- [x] Print the job's bill state in `--job` from `billingState()`: `pending until <completedTime + 24 h>` while rated costs may still lag (Fireworks rates usage up to a day late), `unattributable` when another fine-tuning job ran in the job's window, `unavailable` when `billing/summary` fails, and otherwise the rated training spend from the job's `createTime` to now as the job's bill; a missing or failed read is never shown as zero. Done when: the test covers the four states. Source: https://docs.fireworks.ai/accounts/exporting-usage-and-costs
- [ ] Record under `Probe` each probe job's final state as `probe job <id>: <state>`, Fireworks' error text when it failed, `estimatedCost`, and the bill state; then `training mode: image` only when the image job completed, or `training mode: text-only` only when the image job was `image-refused` and the control job completed; an `unresolved` outcome records no mode, and the probe is rerun after its cause is fixed. Done when: the mode line and the completed job's line exist, the bill reads US$0.00 or `pending` (reconciled in §11), and a non-zero bill stops this file and is recorded for the operator.
- [x] Add a `--delete-probe` mode deleting the job, model and dataset named `isitlegit-probe` and `isitlegit-probe-text`, each only when it exists, then reading each back. Done when: the test shows `DELETE` requests for exactly those names and none for any other resource, and fails the command when a read-back still finds one.
- [ ] Run `--delete-probe` once the probe is recorded. Done when: `node scripts/fireworks-check.ts` lists no `isitlegit-probe` resource.
- [ ] Commit: `glimmer: Fireworks account check and image probe`

**Test checkpoint:** `pnpm exec vitest run test/node/fireworks-check.test.ts` passes and fails if the script sends any non-`GET` request outside `--probe` and `--delete-probe` or deletes a resource not named `isitlegit-probe`, fails if an `unresolved` or failed job yields a training mode, and in `docs/glimmer/training.md` `grep -cE '^training mode: (image|text-only)$'` prints `1` and `grep -cE '^probe job isitlegit-probe(-text)?: JOB_STATE_COMPLETED$'` prints at least `1`.

## 3. PageScreen contract and training store

One definition of what the screener sees and answers, shared by training and production, and one local store for every page the dataset is built from. Training on a different prompt than production uses throws away most of the gain, so the request builder lives in `src/` and both sides import it.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/vision/page-screen.ts`. Done when: the schema, prompt and request builder are tested.
2. Write the store library `scripts/glimmer/store.ts`. Done when: pages are written atomically outside the repository and read back.

- [ ] Define `PageScreen` in `src/vision/page-screen.ts` with zod: `brand` (string or null), `has_login_form`, `has_payment_form`, `lure` (booleans), `lure_type` (`credential`, `payment`, `fake_shop`, `impersonation` for a lookalike company, supplier or social page with no form, or `none`; `none` exactly when `lure` is false), `confidence` (0 to 1), and `screener` (`glimmer` or `spark`, set by the caller, not the model). Done when: `test/vision/page-screen.test.ts` accepts a valid answer and refuses each missing or mistyped field and a `lure_type` that contradicts `lure`. **Corrected 2026-10-28:** `lure_type` added (operator question 2026-10-28 16:12 SAST: fake shops, social networks and corporate sites too; widened 16:15 SAST); the first contract judged only brand lures with a login or payment form.
- [ ] Write `SCREENER_SYSTEM_PROMPT` in `src/vision/page-screen.ts`: the job (is this page a fake: a credential or payment lure, a fake shop, or a lookalike company, supplier or social page, and which of those), the untrusted-content rule, and the JSON-only answer. Done when: the test pins the prompt's hash so any change shows up in review.
- [ ] Write `buildScreenRequest({ image, host, text, mode })` returning the chat `messages` (system prompt; `user` with the host, the text in an untrusted block and, when `mode` is `image`, the screenshot as an `image_url` part), truncating text to 6,000 characters. Done when: the test shows `text-only` mode carries no image part and long text is cut at a whole character.
- [ ] Write `buildTrainingLine(request, answer)` returning one Fireworks JSONL line (`{"messages": [...]}` with the `assistant` answer as the `PageScreen` JSON without `screener`). Done when: the test round-trips a line through `JSON.parse` and the schema. Source: https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm
- [ ] Write `scripts/glimmer/store.ts` resolving the store at `GLIMMER_DATA_DIR` (default `~/isitlegit-data/glimmer`) and refusing any path inside the repository. Done when: `test/node/glimmer-store.test.ts` shows a repository path is refused. Cheaper substitute: a git-ignored folder in the repository, one `git add -f` from a public leak.
- [ ] Write `putPage(source, page)` storing `pages/<id>/screenshot.jpg` (at most 1280 px wide and 2000 px tall), `text.txt` and `meta.json` (`source`, `origin`, `licence`, `labels`, `sha256`, `redacted`), each through a temporary file and rename. Done when: the test writes a page, reads every file back equal, and an interrupted write leaves no partial page. Cheaper substitute: writing files in place.
- [ ] Write `manifest()` listing every stored page with source, labels and hashes, and `counts()` by source and label. Done when: the test's three stored pages appear with correct counts.
- [ ] Write `estimateTokens(line, mode)` for both training modes (`image` counts the screenshot's image tokens, `text-only` none) and refuse lines above 30,000 tokens (under Fireworks' 32,768 training context). Done when: the test refuses an oversized line in each mode. **Corrected 2026-10-28:** was the mode recorded in §2, which made §3 and every data section behind it wait on the Fireworks upload block (D03 T04 §2, `operator`); §10 applies the recorded mode instead and now depends on §2. Source: https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm
- [ ] Commit: `glimmer: PageScreen contract and training store`

**Test checkpoint:** `pnpm exec vitest run test/vision/page-screen.test.ts test/node/glimmer-store.test.ts` passes and fails if the store accepts a path inside the repository or the training line differs from the production request.

## 4. Astra as dataset collector

> **Started:** 2026-10-28T14:20:00Z

The operator chose Astra (GPT-6 Astra through the Codex CLI) to collect public datasets (2026-10-28 15:16 SAST). Astra still never edits the repository: collection runs with network access in a write sandbox rooted in the data store, following a brief Claude writes. Claude writes every script and verifies everything Astra collects; Astra keeps reviewing Claude's code, never its own data.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Record the role change in `AGENTS.md`. Done when: the Astra paragraph names collection and its limits.
2. Write the brief and `scripts/astra-collect.py`. Done when: a dry run prints the exact Codex command rooted outside the repository.

- [x] Edit the Astra paragraph in `AGENTS.md`: Astra may also run collection jobs (operator, 2026-10-28 15:16 SAST) in `codex exec --sandbox workspace-write` rooted at the Glimmer data store with network access, never in the repository; Claude writes the brief and every script, verifies what Astra collects, and Astra never reviews data it collected; Astra may also judge disputed labels and sort the tuned model's misses at `xhigh` in its read-only sandbox (§9, §13; operator, 2026-10-28 15:31 SAST), sample-derived pages only when redacted (consent extended 2026-10-28 15:34 SAST), and `CONTRIBUTIONS.md` lists both uses as development tooling. Done when: `tests/scripts/test_astra_collect.py` finds in the Astra paragraph each rule (collection jobs, `workspace-write` rooted at the data store, never in the repository, Claude writes the brief and every script and verifies the data, Astra never reviews data it collected, label judging at `xhigh` in `read-only`, sample pages only when redacted) and in `CONTRIBUTIONS.md` Astra's dataset collection and label judging, and fails on a copy with any one removed. Cheaper substitute: an unrecorded exception. **Corrected 2026-10-28 (plan review finding 4):** was a single `grep -c 'collection jobs'`, which proves none of the limits.
- [x] Write the brief `docs/glimmer/astra-collection-brief.md`: the goal (phishing, fake-shop, scam-site and benign web pages with screenshots, HTML or visible text, and brand or kind labels), candidate sources to research (Phishpedia, PhishIntention, VisualPhishNet, PILWD-134K, fake-shop and scam-website corpora, and any others found), the licence rule (accept only licences allowing use in a commercial product's model training; research-only, non-commercial or unclear is recorded and not downloaded; spec 4.9), safety rules (download only from the dataset's official page; never open a live phishing URL; never execute files from a download), the output layout (`raw/<source>/` plus `raw/<source>/COLLECTED.md` with URL, licence name, licence quote and link, file list with SHA-256, item count, date), the recovery rules (each download goes to `raw/<source>/.partial/` and moves into place only after its SHA-256 is computed; `COLLECTED.md` is written last, through a temporary file and rename, only when every listed file is in place; a rerun skips a source whose `COLLECTED.md` hashes still match, and deletes `.partial/` and redoes any source without one), and the stop conditions (at most 3 attempts a file, 5 GB a source, 20 GB in all, 30 candidate sources, and 4 hours; reaching one ends the run with a report of what is complete and what is not). Done when: `test/node/astra-brief.test.ts` finds each heading with its substance (the research-only, non-commercial and unclear exclusions, each safety prohibition, each `COLLECTED.md` field, the `.partial/` rule and each numeric stop limit), and fails on a copy of the brief with any one removed. **Corrected 2026-10-28 (plan review findings 3 and 4):** the stop conditions were unnamed, interrupted downloads had no recovery rule, and a heading-only test passed an empty brief.
- [x] Write `scripts/astra-collect.py` that runs `codex exec -m gpt-6-astra -c model_reasoning_effort=high --sandbox workspace-write -c sandbox_workspace_write.network_access=true --skip-git-repo-check --ephemeral --cd <store>/raw -o <store>/raw/ASTRA-REPORT.md -` with the brief on standard input, the store resolved as `scripts/glimmer/store.ts` will resolve it (`GLIMMER_DATA_DIR`, default `~/isitlegit-data/glimmer`), refusing a working directory inside the repository and printing the command with `--dry-run`. Done when: `tests/scripts/test_astra_collect.py` proves the refusal and the dry-run command.
- [x] Make `astra-collect.py` create `<store>/raw` (parents included) before launching, refuse with the reason and without launching when it cannot (a file in the way, no permission), and move an earlier `ASTRA-REPORT.md` aside to `ASTRA-REPORT.<UTC stamp>.md` so a stale report never stands as this run's. Done when: the test creates the default store under a temporary `HOME`, honours a `GLIMMER_DATA_DIR` override, refuses an uncreatable store without launching, and keeps the earlier report under its stamp. **Corrected 2026-10-28 (plan review finding 2):** no step created the store.
- [x] Prove the launch with a fake `codex` on `PATH` that records its arguments, working directory and standard input and exits with a chosen code. Done when: the test shows the exact arguments, the working directory `<store>/raw`, the brief's bytes on standard input, the `-o` path, and the script exiting with the child's non-zero code; it fails when the launch is removed. **Corrected 2026-10-28 (plan review finding 1):** a dry-run-only script passed every earlier test. **Corrected 2026-10-28:** the store is not a git repository, so Codex needs `--skip-git-repo-check` (the dispatcher passes it too, `scripts/review-dispatch.py:366`); the effort is set because the operator's Codex config defaults to `max` (high is this file's default for research, changed in one argument); `-o` keeps Astra's report beside what it collected.
- [x] Extend `scripts/dispatch_hook.py` so `astra-collect.py` and `astra-judge.py` (§9) run only with the Bash tool's `run_in_background` option, as reviews do (`CLAUDE.md`). Done when: `tests/scripts/test_dispatch_hook.py` refuses a foreground and a detached run of each and passes `--dry-run`.
- [x] Make every path in the brief relative to the folder Astra starts in (`<store>/raw`), so `raw/<source>/` cannot land in `<store>/raw/raw/` (completion review C1). Done when: `test/node/astra-brief.test.ts` finds the rule and no `raw/` path but the store folder and the counter-example.
- [x] Hold the 4-hour limit in `astra-collect.py`: at the deadline or on SIGINT, SIGTERM or SIGHUP, SIGTERM to Codex's process group and SIGKILL 5 seconds later, exiting 124 or 130 (completion review C2, E1). Done when: `tests/scripts/test_astra_collect.py` stops a stalled fake that ignores SIGTERM and a cancelled launcher, each with the child gone.
- [x] Write `<store>/raw/RUN-STATUS.json` through a temporary file and rename: `running` at the start, then `completed`, `failed`, `timed-out` or `interrupted` with the exit code (completion review C2). Done when: the test reads each outcome back.
- [x] Print a progress line every 60 seconds while Codex runs: accepted, rejected and incomplete sources and the gigabytes collected (completion review E3). Done when: the test sees the counts from a seeded store.
- [x] Forbid Astra to unpack archives (it lists them to count items) and leave confined, size-bounded extraction to §5's converters (completion review C3). Done when: the brief test finds the rule.
- [x] Add the recovery rule for a `COLLECTED.md` whose listed file is missing or changed (renamed `COLLECTED.invalid-<UTC stamp>.md`, the source collected again, others untouched) and a 10 GB free-disk stop (completion review C4). Done when: the brief test finds both.
- [x] Make the brief test catch the removal of each recovery clause, including "only when every file it lists is in place" and the delete-and-redo rule (completion review C5). Done when: the test fails on a copy with either removed.
- [x] End Codex's whole process group by watching the group, not the Codex parent: SIGKILL reaches a download Codex left behind when it exited on SIGTERM, and a normal exit clears leftovers too (completion review 2, C1). Done when: `tests/scripts/test_astra_collect.py` kills a fake's SIGTERM-ignoring descendant after the fake exits, and the test fails against the earlier parent-only wait.
- [x] End a failed launch, a broken input pipe or a disk error as `failed` with its reason and no traceback; keep a status left `running` by a dead launcher as `RUN-STATUS.<UTC stamp>.json` (`abandoned`) so one relaunch recovers; refuse while a live collection runs (completion review 2, C2, E2). Done when: the tests cover a launch that cannot start, an injected broken pipe, an injected full disk at the end followed by a recovering relaunch, an abandoned status and a live run.
- [x] Treat a zero exit with no `ASTRA-REPORT.md` as a failure, and write a partial report naming each source's state and the reason whenever Astra left none (completion review 2, C3). Done when: the tests read the partial report after a missing report and after a timeout.
- [x] Commit: `glimmer: Astra as dataset collector with its brief`

**Test checkpoint:** `python3 -m unittest tests.scripts.test_astra_collect tests.scripts.test_dispatch_hook` and `pnpm exec vitest run test/node/astra-brief.test.ts` pass, and fail if a collection run can start inside the repository, the launcher never runs Codex, or a brief or `AGENTS.md` rule is removed.

> **Verified:** 2026-10-28 | §4 | 7fcf7b1efafa30c77eab49992fa6293763257fc7
> **Review:** `docs/reviews/d03-t04-s4.json`

## 5. Public phishing-page datasets by licence

Astra researches and downloads public phishing-page datasets under the brief (§4); Claude re-checks every licence at its source, converts the accepted sets into the store and spot-checks their labels. The licence rule is the one D08 T01 §2 applies to mail corpora: anything unclear is not used.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Run the collection. Done when: each candidate has a `COLLECTED.md` or a recorded rejection.
2. Verify and convert. Done when: `docs/glimmer/sources.md` lists every candidate and accepted sets are in the store.

- [ ] Run `python3 scripts/astra-collect.py` in the background and read Astra's report. Done when: every candidate source in the brief has `raw/<source>/COLLECTED.md` or a rejection line with its reason.
- [ ] Re-read each accepted source's licence at its own URL and check every downloaded file's SHA-256 against `COLLECTED.md`. Done when: each source is confirmed or rejected by Claude, and a mismatch removes the source. Cheaper substitute: trusting Astra's licence summary.
- [ ] Record every candidate in `docs/glimmer/sources.md` (public: name, URL, licence, decision, reason, item count; no content). Done when: `test/node/glimmer-sources.test.ts` finds a decision and licence link on each row.
- [ ] Write `extractArchive()` in `scripts/glimmer/archive.ts` unpacking a downloaded archive into a fresh folder with every entry confined to it (absolute paths, `..` and links refused) and the expanded size held to 5 GB a source, stopping cleanly on a full disk with the source marked incomplete (Astra never unpacks, §4 completion review C3). Done when: `test/node/glimmer-archive.test.ts` refuses a `../` entry, a symbolic link and an archive that expands past the limit, and leaves no partial folder.
- [ ] Write one converter per accepted source, `scripts/glimmer/import-<source>.ts`, storing each item through `putPage` with its source labels (`lure`, `brand`) and `origin: public`. Done when: `counts()` shows the source's pages and the converter's test converts a two-item fixture.
- [ ] Spot-check 50 random pages per source by viewing their screenshots against their labels. Done when: the label error rate per source is recorded in `docs/glimmer/training.md` under `Dataset`, and a source above 10 percent errors is relabelled by §9's teacher rather than trusted.
- [ ] If no source is acceptable, record that in `docs/glimmer/sources.md` and raise §8's synthetic target to 3,000 lures. Done when: either imports exist or the decision is recorded.
- [ ] Commit: `glimmer: public phishing-page datasets chosen by licence`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-sources.test.ts` passes, checking every source folder in the store's manifest has a row in `docs/glimmer/sources.md` with a licence.

## 6. Benign real pages rendered locally

The screener must tell lures from the real pages they copy, so the training set needs many real login, checkout and home pages, rendered by our own browser from known-good URLs only. Form flags come from the page's DOM, not a model.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write the URL lists. Done when: the Tranco slice and the South African list exist.
2. Write and run `scripts/glimmer/render.ts`. Done when: benign pages are in the store with DOM form flags.

- [ ] Download the Tranco top list and keep its top 5,000 domains in the store as `raw/tranco/top-5000.csv`, recording its licence and list ID in `docs/glimmer/sources.md`. Done when: the file has 5,000 rows and the row exists. Source: https://tranco-list.eu
- [ ] Write `eval/glimmer/benign-sa-urls.txt`: at least 150 login, checkout and account pages of South African brands lures copy (banks, SARS eFiling, telcos, retailers, couriers, municipalities, Microsoft 365 and Google sign-in), plus at least 50 real shop product and checkout pages, 50 company about and contact pages (including suppliers' banking-details pages where public), and 30 public social network profile or page views, each line tagged with its kind. Done when: `test/node/benign-urls.test.ts` counts at least 150 login, checkout or account URLs and the three new kinds at their minimums, all `https`, none duplicated. **Corrected 2026-10-28:** the shop, company and social kinds added (operator question 2026-10-28 16:12 SAST: fake shops, social networks and corporate sites too; widened 16:15 SAST).
- [ ] Write `scripts/glimmer/render.ts` with `playwright-core` and `chromiumPath()` (`test/node/browser.ts`): 1280 by 800 viewport, downloads refused, 20-second limit, the full-page screenshot cut to 2000 px, and the visible text. Done when: `test/node/glimmer-render.test.ts` renders a local fixture page with both parts.
- [ ] Set `has_login_form` from a visible `input[type=password]` and `has_payment_form` from card fields (`autocomplete` `cc-number` or `cc-csc`, or a payment-provider iframe) in `render.ts`. Done when: the test's login, card and plain fixtures get the right flags.
- [ ] Render the homepage of each Tranco domain and every South African URL, storing results through `putPage` with `lure: false` and `origin: benign`. Done when: `counts()` shows at least 3,000 benign pages and failures are listed in `raw/benign/failures.csv`.
- [ ] Commit: `glimmer: benign real pages rendered locally`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-render.test.ts test/node/benign-urls.test.ts` passes and fails if a password field does not set `has_login_form`.

## 7. Redacted sample mail converted to pages

The 543 sample emails carry real South African lures: credential-harvest HTML attachments that are login pages in themselves, and brand-styled bodies. Under the consent extension recorded 2026-10-28 15:16 SAST, redacted content may go into Fireworks training lines; unredacted content goes only to the Meta Model API. Nothing from `samples/` reaches the repository.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Inventory and redact. Done when: the redactor's tests pass on synthetic fixtures.
2. Render attachments and bodies inertly. Done when: sample-derived pages are in the store, marked redacted, and the leak test passes.

- [ ] Extend the pilot-client rule in `AGENTS.md` (the "Never send real client mail to the Meta Model API" bullet): redacted content may also go into Fireworks training lines for this screener (operator, 2026-10-28 15:16 SAST) and to GPT-6 Astra through the Codex CLI for this work (operator, 2026-10-28 15:34 SAST), unredacted content still goes only to the Meta Model API, and nothing enters a tracked file. Done when: `grep -c 'Fireworks training lines' AGENTS.md` prints `1`. Cheaper substitute: relying on the git-ignored consent file alone while `AGENTS.md` still forbids the use.
- [ ] Confirm `samples/pilot-consent.md` has the "Extension: Fireworks training (2026-10-28 15:16 SAST)" section before reading any sample. Done when: `scripts/glimmer/import-samples.ts` refuses to run without it and its test proves the refusal.
- [ ] Write the inventory step of `scripts/glimmer/import-samples.ts`: per file, its label (`samples/manifest.csv`, or the Microsoft verdict in a quarantine filename), its HTML attachments and whether it has an HTML body. Done when: it prints counts only (no names, subjects or addresses) and the counts sum to 543.
- [ ] Write `scripts/glimmer/redact.ts` replacing email addresses, person names (from the headers and `samples/client-names.txt`), phone numbers, South African ID numbers, bank account and card numbers with fixed placeholders in text and HTML before rendering. Done when: `test/node/glimmer-redact.test.ts` redacts each kind in a synthetic fixture and leaves brand names and links' host names intact. Cheaper substitute: redacting only the visible text while the screenshot still shows the originals.
- [ ] Render each redacted HTML attachment with `render.ts` with JavaScript and network off (inert), storing it with `origin: samples`, `redacted: true` and the label from the inventory. Done when: `counts()` shows the attachment pages.
- [ ] Render each redacted HTML body the same way. Done when: `counts()` shows the body pages and `Spam` or `Bulk` verdicts are stored with `lure` unset for §9 to decide.
- [ ] Write the leak check `test/node/glimmer-leak.test.ts` that scans every `origin: samples` page's text for the pilot client's domain, any address on a recipient line, and every name in `samples/client-names.txt`. Done when: it finds none, and fails on a fixture page that keeps one.
- [ ] Commit: `glimmer: redacted sample mail converted to pages`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-redact.test.ts test/node/glimmer-leak.test.ts` passes and fails if a client name or recipient address survives into a stored page.

## 8. Synthetic South African lures

Public sets are mostly foreign brands. Synthetic pages fill the South African gap, seeded by the lure patterns the sample mail shows (brand, lure type, call to action), with labels known by construction. Every page is inert: no script, no form action, no external resource, no copied logo file.

**Phase:** 0
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Collect seeds and write templates. Done when: `seeds.json` and the fallback templates exist.
2. Generate and render. Done when: synthetic lures and look-alike benign pages are in the store.

- [ ] Extract seeds from §7's lure pages with Muse Spark (`store: false`, through AI Gateway): impersonated brand, lure type (sign-in, payment, invoice, delivery, tax refund), call to action and language, written to the store as `raw/synthetic/seeds.json` without any personal data. Done when: the file has one seed per lure page and the leak check passes on it.
- [ ] Write fallback templates under `scripts/glimmer/templates/` (sign-in, card payment, invoice download, delivery fee, tax refund, fake shop under an invented brand with too-good prices, supplier lookalike with changed banking details, fake social page) with slots for brand name, colours and wording. **Corrected 2026-10-28:** the last three added (operator question 2026-10-28 16:12 SAST: fake shops, social networks and corporate sites too; widened 16:15 SAST). Done when: each renders with `render.ts` from a sample seed.
- [ ] Write `scripts/glimmer/synth.ts` asking Muse Spark for page HTML from a seed and falling back to a template when Spark refuses, recording the refusal rate. Done when: its test with a stubbed Spark produces a page from both paths.
- [ ] Write `inert()` in `synth.ts` removing every `script`, event attribute, external URL and form `action`. Done when: the test's hostile fixture comes out with none of them.
- [ ] Generate at least 1,500 lures across at least 30 South African brands and the 8 template kinds, at least 200 of each `lure_type`, and 500 look-alike benign pages (real-style notices with no form), storing them with `origin: synthetic` and labels by construction, `lure_type` included. Done when: `counts()` shows the totals, every `lure_type` at 200 or more, and no brand above 200 pages. **Corrected 2026-10-28:** per-kind minimums added (operator question 2026-10-28 16:12 SAST: fake shops, social networks and corporate sites too; widened 16:15 SAST).
- [ ] Hold spend to US$20 in total for §8 and §9 together, reserved before each call and settled after in the store's `spend.json` (the pattern in `scripts/meta-smoke.ts`), inside the Meta caps (design spec section 11). Done when: a test at the cap refuses the next call, and the spend is added to the starting totals of the budget guard (D03 T01 §2) as the smoke test's is.
- [ ] Commit: `glimmer: synthetic South African lures`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-synth.test.ts` passes and fails if `inert()` leaves a script, a form action or an external URL.

## 9. Spark teacher labels and human check

Public labels say lure or not; the screener also answers brand and form flags. Muse Spark fills the missing fields as a teacher, every disagreement with a source label goes to a review queue that Astra at `xhigh` and Claude decide independently (a label two model families agree on, or no label), and both check the same random sample before anything trains (operator, 2026-10-28 15:31 SAST). Sample-derived pages go to Astra only when redacted (consent extended 2026-10-28 15:34 SAST). The operator accepted the terms risk of Astra's and Claude's decisions becoming training labels (2026-10-28 15:36 SAST: OpenAI forbids using output to develop models that compete with OpenAI, Anthropic's commercial terms forbid training competing AI models; a narrow phishing-page screener is not judged to compete).

**Phase:** 0
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Label with the teacher. Done when: every stored page has a complete `PageScreen` label or a queue entry.
2. Judge the queue with Astra and Claude. Done when: every queued page has an agreed label or is marked ambiguous.
3. Check a sample. Done when: the measured label error rate and Astra and Claude's agreement are recorded.

- [ ] Write `scripts/glimmer/teacher-label.ts` sending each page with an incomplete label to `muse-spark-1.3` with `buildScreenRequest` and `SCREENER_SYSTEM_PROMPT`, filling only `brand`, `has_login_form` and `has_payment_form` when missing, under §8's spend limit; `lure` always comes from ground truth (the source set, the known-good URL list, construction, or the sample's Microsoft verdict confirmed by Claude), never from Spark, because a student trained on its teacher's answers cannot beat the teacher (operator goal, 2026-10-28 15:29 SAST: Glimmer must beat Spark). Done when: its stubbed test fills a page's missing `brand`, keeps its source `lure`, and refuses to write a `lure` Spark proposed.
- [ ] Queue each page where Spark's `lure` disagrees with its source label in the store's `review-queue.jsonl` instead of overwriting either. Done when: the test's disagreeing page lands in the queue unchanged.
- [ ] Write `scripts/astra-judge.py` running, per page, `codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh --sandbox read-only --cd <store> -i <screenshot> --output-schema <PageScreen JSON schema> <prompt>` with `SCREENER_SYSTEM_PROMPT` and the page text in an untrusted block, writing each answer to the page's `meta.json` as `astra` through a temporary file and rename, and refusing a sample-derived page not marked `redacted`. Done when: `tests/scripts/test_astra_judge.py` shows the command, the refusal of an unredacted sample page, and an answer outside the schema rejected. Cheaper substitute: pasting pages into a chat by hand.
- [ ] Record under `Decisions` in `docs/glimmer/training.md` that the operator accepted the terms risk of Astra's and Claude's decisions becoming training labels (2026-10-28 15:36 SAST), quoting the OpenAI and Anthropic clauses with their links. Done when: the decision line and both links exist.
- [ ] Pilot `astra-judge.py` on 20 queued pages in the background and record time per page, schema failures and the share of the Codex subscription's limit used under `Dataset` in `docs/glimmer/training.md`. Done when: the figures exist and the batch size per run is set from them.
- [ ] Decide every queued page twice, independently: Astra through `astra-judge.py`, and Claude by viewing the screenshot without reading Astra's answer first. Agreement sets the label with `decided_by: astra+claude`; disagreement marks the page `ambiguous`, out of training and evaluation. Done when: the queue is empty and the counts of agreed and ambiguous pages are recorded.
- [ ] Check 200 random labelled pages by eye across all origins, and run them through `astra-judge.py`, recording the error rate per origin and Astra and Claude's agreement rate under `Dataset` in `docs/glimmer/training.md`. Done when: the figures exist; an origin above 5 percent errors is relabelled and checked again.
- [ ] Commit: `glimmer: teacher labels and human check`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-teacher.test.ts` and `python3 -m unittest tests.scripts.test_astra_judge` pass, failing if a teacher answer overwrites a source label instead of queueing the disagreement or an unredacted sample page reaches Astra.

## 10. Deduplicated seed-disjoint training set

The store becomes two files: training and held-out evaluation. Duplicates go, no brand dominates, and the held-out set shares no page, near-duplicate or brand group with training, so the numbers in §13 mean something.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `scripts/glimmer/build-dataset.ts`. Done when: its tests prove dedupe, caps and disjointness.
2. Build and record. Done when: `train.jsonl` and `eval.jsonl` exist and their counts are in `docs/glimmer/training.md`.

- [ ] Drop exact duplicates by text and screenshot SHA-256 and near duplicates by a 64-bit difference hash within 6 bits in `build-dataset.ts`. Done when: `test/node/glimmer-dataset.test.ts` drops a resized copy of a fixture screenshot.
- [ ] Cap pages per brand at 300 and keep lures between 40 and 60 percent of each split. Done when: the test's oversized brand is cut to 300 and the ratio holds.
- [ ] Split by group: hold out 10 percent of brands entirely plus every page of one synthetic template, and put at least 1,000 pages in evaluation, at least 300 of them South African (sample-derived, synthetic or South African benign) and at least 50 of each `lure_type`, so the comparison covers the lures this product exists for. Done when: the test finds no brand, template or near duplicate in both splits and counts the South African slice and each `lure_type`.
- [ ] Keep in evaluation only pages whose every label is ground truth, Claude's decision by eye, or Astra and Claude's agreement (no field filled by Spark, no page marked `ambiguous`), so the test measures the truth rather than agreement with Spark. Done when: the test refuses an evaluation line with a Spark-filled field.
- [ ] Write `train.jsonl` and `eval.jsonl` to the store with `buildTrainingLine` in the training mode §2 recorded (`training mode:` in `docs/glimmer/training.md`), refusing lines over the token limit for that mode (§3) and lines from a page not marked `redacted` when its origin is `samples`. Done when: every line parses and validates against `PageScreen`, and the test proves both refusals. Cheaper substitute: a separate prompt string in the script.
- [ ] Run the leak check (§7) over both files. Done when: it finds nothing.
- [ ] Record line counts by origin and label, the brand count, and the SHA-256 of both files under `Dataset` in `docs/glimmer/training.md`, plus the screenshot hash list `docs/glimmer/eval-hashes.txt` (hashes only) for §1's set to check against. Done when: the figures and the hash list exist.
- [ ] Commit: `glimmer: deduplicated, balanced, seed-disjoint training set`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-dataset.test.ts` passes and fails if a brand or near-duplicate appears in both splits.

## 11. Free SFT job on Muse Glimmer 30B

Train the LoRA on Fireworks while the free offer lasts (until 2026-11-30), with the admin key in a local script only. The tuned model is named Loupe (operator request, 2026-10-28 15:59 SAST; the name proposed and taken at 16:00 SAST: a jeweller's loupe tells a real stone from a fake, and it sits beside Glimmer and Spark): each training run is one version numbered major.minor (operator, 2026-10-28 16:03 SAST): Loupe 1.0 first, then 1.1, 1.2 and on for each retrain, written `isitlegit-loupe-1-0` on Fireworks (model IDs take no dots) and "Loupe 1.0 (Muse Glimmer 30B, LoRA)" in documents; the major number moves to 2.0 only for a new base model or a changed `PageScreen` contract, and a version number is never reused, a failed run's included. Renaming before 1.0 trains costs one plan edit; after it, the trained model keeps its name.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `scripts/glimmer/train.ts`. Done when: its tests prove the date and file checks.
2. Train and record. Done when: the tuned model's ID and the job's billed amount are recorded.

- [ ] Write `scripts/glimmer/train.ts` uploading `train.jsonl` as a Fireworks dataset and creating a supervised fine-tuning job on `accounts/fireworks/models/muse-glimmer-30b` (LoRA, Fireworks' default rank, 1 epoch, output model `isitlegit-loupe-1-0`), reading the admin key through `conclave-op`. Done when: `test/node/glimmer-train.test.ts` shows the requests with a stubbed transport. Source: https://docs.fireworks.ai/fine-tuning/supervised-fine-tuning
- [ ] Refuse to start on or after 2026-11-01 12:00 SAST (training takes hours, and every test and retrain is finished before 2026-11-02 00:00 SAST for the competition; operator, 2026-10-28 15:29 SAST), which also keeps every run inside the free offer (until 2026-11-30), or when the file's SHA-256 differs from the one recorded in `docs/glimmer/training.md`. Done when: the test proves both refusals.
- [ ] Before the first upload, reconcile §2's probe bill: read the rated training spend over each probe job's window once 24 hours have passed since it completed, and record the result under `Probe` beside the earlier `pending` line. Done when: the line reads `reconciled: US$0.00`; a non-zero amount stops this file and is recorded for the operator.
- [ ] Record each Loupe version under `Training` in `docs/glimmer/training.md` as `Loupe <version>: <Fireworks model ID>, trained <date>, dataset <train.jsonl SHA-256>, job <id>` when its job is created. Done when: the line exists for every version started, failed ones included.
- [ ] Poll the job until it ends, writing its state to `docs/glimmer/training.md` under `Training` after each change. Done when: an interrupted script resumes polling the same job ID instead of starting another.
- [ ] Record the tuned model's ID, training loss at the end, run time and the amount billed. Done when: the billed amount is US$0.00; a non-zero bill stops this file and is recorded for the operator.
- [ ] On a failed job, record Fireworks' error, fix the cause in the dataset or the request, and run again as the next Loupe version (`isitlegit-loupe-1-1`, then `-1-2`; a version is never reused, a failed one included). Done when: a finished model exists or the failure is recorded for the operator with its cause.
- [ ] Commit: `glimmer: free SFT job on Muse Glimmer 30B`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-train.test.ts` passes and fails if a job can start after 2026-11-01 12:00 SAST or on a dataset whose hash was not recorded.

## 12. Deployment with 5-minute scale to zero

Serve the tuned model from one dedicated deployment with live merge, zero minimum replicas, one maximum and a 5-minute scale-to-zero window (the operator's limits; Fireworks' minimum). Every change sends an update mask, because an update without one zeroes every unmentioned field.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `scripts/glimmer/deploy.ts`. Done when: its tests prove masks and read-back.
2. Deploy and record. Done when: the deployment's settings are read back and recorded.

- [ ] Write `ensure` in `scripts/glimmer/deploy.ts` creating, or getting if it exists, a deployment of the tuned model with live merge on one H100 80 GB, `minReplicaCount` 0, `maxReplicaCount` 1 and `scaleToZeroWindow` 5 minutes, reading the admin key through `conclave-op`. Done when: `test/node/glimmer-deploy.test.ts` shows the create body and that a second `ensure` creates nothing. Source: https://docs.fireworks.ai/fine-tuning/deploying-loras, https://docs.fireworks.ai/deployments/autoscaling
- [ ] Send every update with an explicit update mask and refuse to build an update request without one. Done when: the test proves the refusal. Source: https://docs.fireworks.ai/api-reference/training-sdk/deployment-management
- [ ] Write `stop` (minimum and maximum replicas to 0, deployment kept), `start` (maximum back to 1) and `status` (replica count, settings, last update). Done when: the test shows each request's mask and body.
- [ ] Read the deployment back after every change and refuse to report success unless minimum 0, maximum as asked and scale-to-zero 5 minutes all match. Done when: the test's mismatched read-back fails the command.
- [ ] Run `ensure`, then record the deployment name, GPU, settings read back and the inference model string under `Deployment` in `docs/glimmer/training.md`. Done when: the record exists and `status` shows 0 replicas after the idle window.
- [ ] Prove the inference-only key ("IsItLegit Fireworks") can call the deployment and cannot change it. Done when: a one-token call answers (after warm-up) and a `PATCH` with that key is refused, both recorded.
- [ ] Commit: `glimmer: dedicated deployment with 5-minute scale to zero`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-deploy.test.ts` passes and fails if an update is sent without a mask or a mismatched read-back reports success.

## 13. Warm-up and held-out accuracy measured

Measure what the runtime design depends on: how long warm-up really takes, that the deployment really scales to zero after 5 minutes, and whether the tuned Glimmer beats Spark on the held-out set. Every session keeps the day's running time within 30 minutes through a local ledger.

**Phase:** 0
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `scripts/glimmer/measure.ts` with its local ledger. Done when: a session that would pass 30 minutes refuses to start.
2. Measure and decide. Done when: warm-up figures and the comparison rows are recorded.

- [ ] Write the local ledger in `scripts/glimmer/measure.ts` (`build/glimmer-runtime.json`, atomic writes) counting each burst from its first request to its last answer plus 5 minutes, and refusing a session when the day's minutes plus the session's estimate would pass 30. Done when: `test/node/glimmer-measure.test.ts` refuses at the limit. Cheaper substitute: watching the clock by hand.
- [ ] Measure warm-up five times on separate days or after a confirmed scale to zero: time from the first `503 DEPLOYMENT_SCALING_UP` to the first answer, retrying with exponential backoff. Done when: median and maximum are recorded under `Measurements` in `docs/glimmer/training.md`.
- [ ] Confirm scale to zero: `deploy.ts status` shows 0 replicas within 7 minutes of the last request. Done when: the observed time is recorded.
- [ ] Run `eval.jsonl` (or the largest slice the day's minutes allow, the slice recorded) through the tuned Glimmer and through Muse Spark. Done when: each one's accuracy, lure recall, false alarms, latency and cost per page are rows in `docs/frontier-log.md`, overall, for the South African slice and per `lure_type`, with the pages each one missed listed by ID.
- [ ] Judge the run against the bar (operator, 2026-10-28 15:29 SAST: Glimmer must beat Spark): the tuned Glimmer passes when its lure recall is higher than Spark's and its false-alarm rate is no higher, overall and on the South African slice. Done when: `docs/glimmer/training.md` records `bar: passed` or `bar: failed` with the four figures for each run.
- [ ] Before any retrain, sort the tuned Glimmer's misses and false alarms into causes (brand absent from training, lure type underrepresented, screenshot cut too short, text truncated, wrong label): Astra proposes a cause for each page through `astra-judge.py` at `xhigh`, Claude confirms or corrects every proposal, and the counts go under `Measurements`. Done when: every miss has a cause and the retrain's data change names the causes it answers.
- [ ] Record under `Decisions` which training run is final: Glimmer is the screener whatever the comparison shows (operator, 2026-10-28 15:26 SAST); when its lure recall is below Spark's, record the misses, fix their cause in the data (§9, §10) and train again (§11) as the next Loupe version (1.1, then 1.2), at most two more runs, all testing and retraining finished before 2026-11-02 00:00 SAST for the competition (operator, 2026-10-28 15:29 SAST; submission closes 2026-11-04 18:00 SAST); when the deadline arrives, the run with the best lure recall so far is final. Done when: the line names the final Loupe version and its recall beside Spark's, recorded before 2026-11-02 00:00 SAST.
- [ ] Delete the uploaded copies of the training files from the Fireworks account once the final training run is recorded, so the redacted sample content is kept only in the local store; the trained model and the local files stay, and a retrain uploads again from the store. Done when: `node scripts/fireworks-check.ts` lists no IsItLegit dataset and still lists the final model.
- [ ] Commit: `glimmer: warm-up and held-out accuracy measured`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-measure.test.ts` passes and fails if a session can start past 30 minutes, and `grep -c 'warm-up median' docs/glimmer/training.md` prints `1`.

## 14. Daily 30-minute runtime ledger

Fireworks has no daily runtime cap, so the Worker holds the deployment to 30 minutes a day by deciding when to stop sending requests: with no requests, the deployment scales to zero 5 minutes later on its own. The inference-only key cannot scale the deployment, and the admin key never enters the Worker. Phase 3 (the vision phase) so it is ready before the monitor (phase 6) needs it.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Add the ledger table and `src/vision/glimmer-minutes.ts`. Done when: tests count bursts and refuse at the limit.
2. Share it with the local scripts. Done when: `measure.ts` reads and writes the same ledger.

- [ ] Add a migration `glimmer_runtime` (`day` SAST date, `burst_id`, `wake_at`, `last_answer_at`, `closed`). Done when: it applies locally.
- [ ] Put the limits in `src/vision/glimmer-caps.ts` as constants with the decision reference: 30 minutes a day, 5-minute scale-to-zero tail, US$8.00 an hour, US$5 a day and US$90 in total (design spec section 11). Done when: the admin overview's Fireworks bars (`design/SPEC.md`, model spend against caps) can import them. Cheaper substitute: environment variables a run could raise.
- [ ] Write `minutesUsed(day)` in `src/vision/glimmer-minutes.ts`: each burst counts from its wake request to its last answer plus 5 minutes, warm-up included. Done when: `test/vision/glimmer-minutes.test.ts` computes two recorded bursts exactly.
- [ ] Write `mayCall(now, expectedSeconds)` refusing when today's minutes plus the open burst's projection (now, plus the call, plus the 5-minute tail) would pass 30, or, for a new burst, when fewer minutes remain than the measured maximum warm-up (§13) plus the tail plus one call. Done when: the test refuses at both edges and allows just under them.
- [ ] Refuse also when the money caps would be passed, the minutes priced at US$8.00 an hour. Done when: a test at US$5 for the day refuses.
- [ ] Make `scripts/glimmer/measure.ts` read and write the D1 ledger (`wrangler d1 execute --remote`) instead of `build/glimmer-runtime.json` once this table exists. Done when: a local session and a Worker burst on the same day add up in one total.
- [ ] Commit: `vision: daily 30-minute runtime ledger for the Glimmer deployment`

**Test checkpoint:** `pnpm exec vitest run test/vision/glimmer-minutes.test.ts` passes and fails if warm-up or the 5-minute tail is left out of the count.

## 15. Warm-up handling and wake call

A scaled-to-zero deployment answers the first request with an immediate `503 DEPLOYMENT_SCALING_UP` and queues nothing. This section provides `wakeGlimmer`, which the monitor run calls at its start so warm-up overlaps the DNS checks (that call is D05 T04 §2's, the file that owns the run), and the retry the screener uses until the measured warm-up limit, after which Spark takes the page.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Write `wakeGlimmer` and the retry. Done when: tests cover a warm-up that ends in time and one that does not.
2. Handle a missing deployment. Done when: a 404 gives its reason and one operator notice.

- [ ] Write `wakeGlimmer(ctx)` in `src/vision/glimmer-wake.ts` sending one 1-token request that opens a burst in the ledger (§14), only when `mayCall` allows a new burst. Done when: `test/vision/glimmer-wake.test.ts` shows no request when the day's minutes are spent.
- [ ] Retry on `503` with `DEPLOYMENT_SCALING_UP` with exponential backoff (5 seconds doubling, capped at 30) until the measured maximum warm-up plus 60 seconds (§13), then return `warming` for Spark to take the page. Done when: the test's stubbed warm-up ends in time once and runs over once. Source: https://docs.fireworks.ai/deployments/autoscaling
- [ ] Return `deployment_missing` on a 404 (Fireworks deletes deployments idle for 7 days) and send the operator one notice naming `node scripts/glimmer/deploy.ts ensure`. Done when: the test's 404 gives the reason and one notice across two calls.
- [ ] Commit: `vision: Glimmer warm-up handling and wake call`

**Test checkpoint:** `pnpm exec vitest run test/vision/glimmer-wake.test.ts` passes and fails if a `503` during warm-up is treated as a final failure instead of retried.

## 16. Resumable verified dataset downloads

Filed 2026-10-28 from D03 T04 §4's completion review (E2): a collection interrupted at 90 percent of a large download starts that file again, because the brief deletes `.partial/` on a rerun; a downloader such as aria2 resumes it. Resuming must keep the rule that no file is accepted until its full SHA-256 is checked.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Write the resumable fetch. Done when: an interrupted transfer resumes from its last byte and is still verified whole.
2. Point the brief at it. Done when: the brief's recovery rule keeps `.partial/` files for resumption.

- [ ] Write `scripts/glimmer/fetch.py` downloading one URL into `<source>/.partial/` with HTTP range requests, resuming from the partial file's length when the server answers `206` and starting over on `200`, then computing the whole file's SHA-256 before moving it into place. Done when: `tests/scripts/test_glimmer_fetch.py` interrupts a local 10 MB transfer at 90 percent and the resumed run fetches at most the last 10 percent plus 64 KB, and a server that ignores ranges is fetched whole. Source: RFC 9110 section 14 (range requests).
- [ ] Refuse a resumed file whose final SHA-256 differs from the one the dataset publishes, deleting the partial file. Done when: the test's corrupted partial file is refused and removed.
- [ ] Change the brief's recovery rule to keep `.partial/` files and resume them with `fetch.py`, and its test to require the new rule. Done when: `test/node/astra-brief.test.ts` passes with the resume rule and fails without it.
- [ ] Commit: `glimmer: resumable verified dataset downloads`

**Test checkpoint:** `python3 -m unittest tests.scripts.test_glimmer_fetch` passes and fails if a resumed transfer refetches the whole file or a mismatched file is accepted.

## Verification

- The monitor screens pages on the fine-tuned Glimmer deployment, falls over to Muse Spark in Standard mode, and records each page's screener, reason and cost.
- The deployment's daily running time, warm-up included, never passes 30 minutes in the ledger, and it reads 0 replicas 5 minutes after its last request.
- `docs/glimmer/sources.md` and `docs/glimmer/training.md` account for every training source, licence, count and decision, and no sample-derived content is in the repository.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
