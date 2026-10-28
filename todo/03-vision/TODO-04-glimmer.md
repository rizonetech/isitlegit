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
| 2 | §3 | PageScreen contract and training store | §2 | [ ] |
| 3 | §4 | Astra as dataset collector | -- | [ ] |
| 4 | §5 | Public phishing-page datasets by licence | §3, §4 | [ ] |
| 5 | §6 | Benign real pages rendered locally | §3 | [ ] |
| 6 | §7 | Redacted sample mail converted to pages | §3, §6 | [ ] |
| 7 | §8 | Synthetic South African lures | §6, §7 | [ ] |
| 8 | §9 | Spark teacher labels and human check | §5, §6, §7, §8 | [ ] |
| 9 | §10 | Deduplicated seed-disjoint training set | §9 | [ ] |
| 10 | §11 | Free SFT job on Muse Glimmer 30B | §10 | [ ] |
| 11 | §12 | Deployment with 5-minute scale to zero | §11 | [ ] |
| 12 | §13 | Warm-up and held-out accuracy measured | §12 | [ ] |
| 13 | §14 | Daily 30-minute runtime ledger | §12, D03 T01 §2 | [ ] |
| 14 | §15 | Warm-up handling and wake call | §14 | [ ] |
| 15 | §1 | Glimmer screener, Spark failover | D03 T02 §3, §13, §15 | [ ] |

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

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `scripts/fireworks-check.ts`. Done when: it prints models, deployments, datasets, jobs, credit redemptions and rated spend without creating anything.
2. Run a 3-example image SFT job on Glimmer, then delete what it made. Done when: `docs/glimmer/training.md` records accepted or refused, with the job id and its billed amount, and the account holds no probe resource.

- [ ] Write `scripts/fireworks-check.ts` reading the admin key from the vault item "IsItLegit Fireworks Admin" through `conclave-op` (never printed, the pattern in `scripts/meta-smoke.ts`), listing the account's models, deployments, datasets, supervised fine-tuning jobs, credit redemptions and this month's rated spend by category (`billing/summary`). Done when: `node scripts/fireworks-check.ts` prints the six lists and `test/node/fireworks-check.test.ts` shows the default mode only issues `GET` requests and that the key never appears in its output. Source: Fireworks REST API under `https://api.fireworks.ai/v1/accounts/rizonetech`, https://docs.fireworks.ai/accounts/exporting-usage-and-costs. **Corrected 2026-10-28:** was "models, deployments and credit balance"; no balance call exists.
- [ ] Create `docs/glimmer/training.md` with sections `Account`, `Probe`, `Dataset`, `Training`, `Deployment`, `Measurements` and `Decisions`, and record the check's output (model, deployment, dataset and job counts, the credit redemption's date, the month's rated spend, and the operator's US$100 as the balance of record) under `Account`. Done when: the file exists with those headings and the spend figure. Cheaper substitute: keeping the numbers in chat.
- [ ] Make three probe lines in `build/glimmer/probe.jsonl` from our own fixture images (`code-card.png`, `logo-card.png` and `continue-page.png` in `test/fixtures/meta-smoke/`), each a `user` message with an `image_url` base64 part and an `assistant` answer drawn from `fixtures.json`, written by `probeLines()` in `scripts/fireworks-check.ts`. Done when: the test shows 3 lines that parse as JSON with one image part each. Source: https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm. **Corrected 2026-10-28:** was one meta-smoke image and two new fixtures; the three meta-smoke cards are already our own images with known answers.
- [ ] Add a `--probe` mode to `scripts/fireworks-check.ts` that uploads `build/glimmer/probe.jsonl` as dataset `isitlegit-probe` and starts one SFT job on `accounts/fireworks/models/muse-glimmer-30b` (one epoch, output model `isitlegit-probe`), refusing to run on or after 2026-12-01 (the free offer ends 2026-11-30) or when a probe resource already exists. Done when: the job id is printed and `test/node/fireworks-check.test.ts` proves the date refusal, the existing-probe refusal and the requests' bodies.
- [ ] Add a `--job <id>` mode printing one job's state, status message and `estimatedCost` with `GET` only. Done when: the test shows the single `GET` and the printed state.
- [ ] Record under `Probe` whether the job accepted image lines or refused them (with Fireworks' error text), its final state, and the amount billed for it from the account's rated training spend. Done when: the record names `image` or `text-only` as the training mode and the billed amount is US$0.00; a non-zero bill stops this file and is recorded for the operator.
- [ ] Add a `--delete-probe` mode deleting the `isitlegit-probe` job, model and dataset, each only when it exists and only those names. Done when: the test shows `DELETE` requests for exactly those three names and none for any other resource.
- [ ] Run `--delete-probe` once the probe is recorded. Done when: `node scripts/fireworks-check.ts` lists no `isitlegit-probe` resource.
- [ ] Commit: `glimmer: Fireworks account check and image probe`

**Test checkpoint:** `pnpm exec vitest run test/node/fireworks-check.test.ts` passes and fails if the script sends any non-`GET` request outside `--probe` and `--delete-probe` or deletes a resource not named `isitlegit-probe`, and `grep -cE '^training mode: (image|text-only)$' docs/glimmer/training.md` prints `1`.

## 3. PageScreen contract and training store

One definition of what the screener sees and answers, shared by training and production, and one local store for every page the dataset is built from. Training on a different prompt than production uses throws away most of the gain, so the request builder lives in `src/` and both sides import it.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/vision/page-screen.ts`. Done when: the schema, prompt and request builder are tested.
2. Write the store library `scripts/glimmer/store.ts`. Done when: pages are written atomically outside the repository and read back.

- [ ] Define `PageScreen` in `src/vision/page-screen.ts` with zod: `brand` (string or null), `has_login_form`, `has_payment_form`, `lure` (booleans), `confidence` (0 to 1), and `screener` (`glimmer` or `spark`, set by the caller, not the model). Done when: `test/vision/page-screen.test.ts` accepts a valid answer and refuses each missing or mistyped field.
- [ ] Write `SCREENER_SYSTEM_PROMPT` in `src/vision/page-screen.ts`: the job (is this page a brand lure with a login or payment form), the untrusted-content rule, and the JSON-only answer. Done when: the test pins the prompt's hash so any change shows up in review.
- [ ] Write `buildScreenRequest({ image, host, text, mode })` returning the chat `messages` (system prompt; `user` with the host, the text in an untrusted block and, when `mode` is `image`, the screenshot as an `image_url` part), truncating text to 6,000 characters. Done when: the test shows `text-only` mode carries no image part and long text is cut at a whole character.
- [ ] Write `buildTrainingLine(request, answer)` returning one Fireworks JSONL line (`{"messages": [...]}` with the `assistant` answer as the `PageScreen` JSON without `screener`). Done when: the test round-trips a line through `JSON.parse` and the schema. Source: https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm
- [ ] Write `scripts/glimmer/store.ts` resolving the store at `GLIMMER_DATA_DIR` (default `~/isitlegit-data/glimmer`) and refusing any path inside the repository. Done when: `test/node/glimmer-store.test.ts` shows a repository path is refused. Cheaper substitute: a git-ignored folder in the repository, one `git add -f` from a public leak.
- [ ] Write `putPage(source, page)` storing `pages/<id>/screenshot.jpg` (at most 1280 px wide and 2000 px tall), `text.txt` and `meta.json` (`source`, `origin`, `licence`, `labels`, `sha256`, `redacted`), each through a temporary file and rename. Done when: the test writes a page, reads every file back equal, and an interrupted write leaves no partial page. Cheaper substitute: writing files in place.
- [ ] Write `manifest()` listing every stored page with source, labels and hashes, and `counts()` by source and label. Done when: the test's three stored pages appear with correct counts.
- [ ] Estimate one line's token count for the training mode recorded in §2 and refuse lines above 30,000 tokens (under Fireworks' 32,768 training context). Done when: the test refuses an oversized line. Source: https://docs.fireworks.ai/fine-tuning/fine-tuning-vlm
- [ ] Commit: `glimmer: PageScreen contract and training store`

**Test checkpoint:** `pnpm exec vitest run test/vision/page-screen.test.ts test/node/glimmer-store.test.ts` passes and fails if the store accepts a path inside the repository or the training line differs from the production request.

## 4. Astra as dataset collector

The operator chose Astra (GPT-6 Astra through the Codex CLI) to collect public datasets (2026-10-28 15:16 SAST). Astra still never edits the repository: collection runs with network access in a write sandbox rooted in the data store, following a brief Claude writes. Claude writes every script and verifies everything Astra collects; Astra keeps reviewing Claude's code, never its own data.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Record the role change in `AGENTS.md`. Done when: the Astra paragraph names collection and its limits.
2. Write the brief and `scripts/astra-collect.py`. Done when: a dry run prints the exact Codex command rooted outside the repository.

- [ ] Edit the Astra paragraph in `AGENTS.md`: Astra may also run collection jobs (operator, 2026-10-28 15:16 SAST) in `codex exec --sandbox workspace-write` rooted at the Glimmer data store with network access, never in the repository; Claude writes the brief and every script, verifies what Astra collects, and Astra never reviews data it collected; Astra may also judge disputed labels and sort the tuned model's misses at `xhigh` in its read-only sandbox (§9, §13; operator, 2026-10-28 15:31 SAST), sample-derived pages only when redacted (consent extended 2026-10-28 15:34 SAST), and `CONTRIBUTIONS.md` lists both uses as development tooling. Done when: `grep -c 'collection jobs' AGENTS.md` prints `1` and `CONTRIBUTIONS.md` names Astra's dataset collection and label judging. Cheaper substitute: an unrecorded exception.
- [ ] Write the brief `docs/glimmer/astra-collection-brief.md`: the goal (phishing and benign web pages with screenshots, HTML or visible text, and brand labels), candidate sources to research (Phishpedia, PhishIntention, VisualPhishNet, PILWD-134K and any others found), the licence rule (accept only licences allowing use in a commercial product's model training; research-only, non-commercial or unclear is recorded and not downloaded; spec 4.9), safety rules (download only from the dataset's official page; never open a live phishing URL; never execute files from a download), the output layout (`raw/<source>/` plus `raw/<source>/COLLECTED.md` with URL, licence name, licence quote and link, file list with SHA-256, item count, date), and the stop conditions. Done when: `test/node/astra-brief.test.ts` finds each of those headings.
- [ ] Write `scripts/astra-collect.py` that runs `codex exec -m gpt-6-astra --sandbox workspace-write -c sandbox_workspace_write.network_access=true --cd <store>/raw` with the brief as the prompt, refusing a working directory inside the repository and printing the command with `--dry-run`. Done when: `tests/scripts/test_astra_collect.py` proves the refusal and the dry-run command.
- [ ] Extend `scripts/dispatch_hook.py` so `astra-collect.py` and `astra-judge.py` (§9) run only with the Bash tool's `run_in_background` option, as reviews do (`CLAUDE.md`). Done when: `tests/scripts/test_dispatch_hook.py` refuses a foreground and a detached run of each and passes `--dry-run`.
- [ ] Commit: `glimmer: Astra as dataset collector with its brief`

**Test checkpoint:** `python3 -m unittest tests.scripts.test_astra_collect tests.scripts.test_dispatch_hook` passes and fails if a collection run can start inside the repository.

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
- [ ] Write `eval/glimmer/benign-sa-urls.txt`: at least 150 login, checkout and account pages of South African brands lures copy (banks, SARS eFiling, telcos, retailers, couriers, municipalities, Microsoft 365 and Google sign-in). Done when: `test/node/benign-urls.test.ts` counts at least 150 `https` URLs, none duplicated.
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
- [ ] Write fallback templates under `scripts/glimmer/templates/` (sign-in, card payment, invoice download, delivery fee, tax refund) with slots for brand name, colours and wording. Done when: each renders with `render.ts` from a sample seed.
- [ ] Write `scripts/glimmer/synth.ts` asking Muse Spark for page HTML from a seed and falling back to a template when Spark refuses, recording the refusal rate. Done when: its test with a stubbed Spark produces a page from both paths.
- [ ] Write `inert()` in `synth.ts` removing every `script`, event attribute, external URL and form `action`. Done when: the test's hostile fixture comes out with none of them.
- [ ] Generate at least 1,500 lures across at least 30 South African brands and 5 lure types, and 500 look-alike benign pages (real-style notices with no form), storing them with `origin: synthetic` and labels by construction. Done when: `counts()` shows both totals and no brand above 200 pages.
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
- [ ] Split by group: hold out 10 percent of brands entirely plus every page of one synthetic template, and put at least 1,000 pages in evaluation, at least 300 of them South African (sample-derived, synthetic or South African benign) so the comparison covers the lures this product exists for. Done when: the test finds no brand, template or near duplicate in both splits and counts the South African slice.
- [ ] Keep in evaluation only pages whose every label is ground truth, Claude's decision by eye, or Astra and Claude's agreement (no field filled by Spark, no page marked `ambiguous`), so the test measures the truth rather than agreement with Spark. Done when: the test refuses an evaluation line with a Spark-filled field.
- [ ] Write `train.jsonl` and `eval.jsonl` to the store with `buildTrainingLine`, refusing lines over the token limit (§3) and lines from a page not marked `redacted` when its origin is `samples`. Done when: every line parses and validates against `PageScreen`, and the test proves both refusals. Cheaper substitute: a separate prompt string in the script.
- [ ] Run the leak check (§7) over both files. Done when: it finds nothing.
- [ ] Record line counts by origin and label, the brand count, and the SHA-256 of both files under `Dataset` in `docs/glimmer/training.md`, plus the screenshot hash list `docs/glimmer/eval-hashes.txt` (hashes only) for §1's set to check against. Done when: the figures and the hash list exist.
- [ ] Commit: `glimmer: deduplicated, balanced, seed-disjoint training set`

**Test checkpoint:** `pnpm exec vitest run test/node/glimmer-dataset.test.ts` passes and fails if a brand or near-duplicate appears in both splits.

## 11. Free SFT job on Muse Glimmer 30B

Train the LoRA on Fireworks while the free offer lasts (until 2026-11-30), with the admin key in a local script only.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Write `scripts/glimmer/train.ts`. Done when: its tests prove the date and file checks.
2. Train and record. Done when: the tuned model's ID and the job's billed amount are recorded.

- [ ] Write `scripts/glimmer/train.ts` uploading `train.jsonl` as a Fireworks dataset and creating a supervised fine-tuning job on `accounts/fireworks/models/muse-glimmer-30b` (LoRA, Fireworks' default rank, 1 epoch, output model `isitlegit-screener-v1`), reading the admin key through `conclave-op`. Done when: `test/node/glimmer-train.test.ts` shows the requests with a stubbed transport. Source: https://docs.fireworks.ai/fine-tuning/supervised-fine-tuning
- [ ] Refuse to start on or after 2026-11-01 12:00 SAST (training takes hours, and every test and retrain is finished before 2026-11-02 00:00 SAST for the competition; operator, 2026-10-28 15:29 SAST), which also keeps every run inside the free offer (until 2026-11-30), or when the file's SHA-256 differs from the one recorded in `docs/glimmer/training.md`. Done when: the test proves both refusals.
- [ ] Poll the job until it ends, writing its state to `docs/glimmer/training.md` under `Training` after each change. Done when: an interrupted script resumes polling the same job ID instead of starting another.
- [ ] Record the tuned model's ID, training loss at the end, run time and the amount billed. Done when: the billed amount is US$0.00; a non-zero bill stops this file and is recorded for the operator.
- [ ] On a failed job, record Fireworks' error, fix the cause in the dataset or the request, and run again with a new output model name. Done when: a finished model exists or the failure is recorded for the operator with its cause.
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
- [ ] Run `eval.jsonl` (or the largest slice the day's minutes allow, the slice recorded) through the tuned Glimmer and through Muse Spark. Done when: each one's accuracy, lure recall, false alarms, latency and cost per page are rows in `docs/frontier-log.md`, overall and for the South African slice, with the pages each one missed listed by ID.
- [ ] Judge the run against the bar (operator, 2026-10-28 15:29 SAST: Glimmer must beat Spark): the tuned Glimmer passes when its lure recall is higher than Spark's and its false-alarm rate is no higher, overall and on the South African slice. Done when: `docs/glimmer/training.md` records `bar: passed` or `bar: failed` with the four figures for each run.
- [ ] Before any retrain, sort the tuned Glimmer's misses and false alarms into causes (brand absent from training, lure type underrepresented, screenshot cut too short, text truncated, wrong label): Astra proposes a cause for each page through `astra-judge.py` at `xhigh`, Claude confirms or corrects every proposal, and the counts go under `Measurements`. Done when: every miss has a cause and the retrain's data change names the causes it answers.
- [ ] Record under `Decisions` which training run is final: Glimmer is the screener whatever the comparison shows (operator, 2026-10-28 15:26 SAST); when its lure recall is below Spark's, record the misses, fix their cause in the data (§9, §10) and train again (§11) with a new output model name, at most two more runs, all testing and retraining finished before 2026-11-02 00:00 SAST for the competition (operator, 2026-10-28 15:29 SAST; submission closes 2026-11-04 18:00 SAST); when the deadline arrives, the run with the best lure recall so far is final. Done when: the line names the final model and its recall beside Spark's, recorded before 2026-11-02 00:00 SAST.
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

## Verification

- The monitor screens pages on the fine-tuned Glimmer deployment, falls over to Muse Spark in Standard mode, and records each page's screener, reason and cost.
- The deployment's daily running time, warm-up included, never passes 30 minutes in the ledger, and it reads 0 replicas 5 minutes after its last request.
- `docs/glimmer/sources.md` and `docs/glimmer/training.md` account for every training source, licence, count and decision, and no sample-derived content is in the repository.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
