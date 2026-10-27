---
schema_version: 1
id: glimmer
domain: 03-vision
status: active
title: "TODO-04 -- Muse Glimmer Screening Through a Hosted Provider"
track: day-6
---

# TODO-04 -- Muse Glimmer Screening Through a Hosted Provider

> **Goal:** The impersonation monitor screens candidate pages through one `screenPage` interface that ships with Muse Spark, and Muse Glimmer (open weights, 30B, text and image in, through a hosted provider, Baseten first, inside its own US$10 budget; **Corrected 2026-10-27:** was Fireworks AI first) replaces Spark there only when a recorded comparison shows it misses no lure Spark finds. **Corrected 2026-10-27 (operator: a Fireworks issue must not stop development):** the monitor no longer waits on the provider: Spark screens from day one, Glimmer is a measured upgrade.

> **Current state:** Measured 2026-10-26 20:00 SAST. No provider account or key yet (D99 T01 §7). Glimmer is not on the Meta Model API (spec 9). **Updated 2026-10-27 01:10 SAST:** a Fireworks account exists but the event credit has not arrived and Fireworks has an open issue; no key is stored. **Updated 2026-10-27 10:30 SAST:** Baseten's partner credit (US$100, up to 2M tokens a minute) covers only `meta-models/muse-spark-open-1026`, Meta's open-weights Muse Spark (text and image in, always reasoning; verified with a text and an image call), not Muse Glimmer, which this key cannot deploy or call. How the monitor's screening uses it is the operator's open decision (2026-10-27). Earlier note: **Updated 2026-10-27 09:58 SAST, corrected 10:06:** Baseten issued an API key (a credit balance is not confirmed yet; checked 10:20 SAST: the key lists models but is refused for inference and workspace calls, so Glimmer cannot be deployed or called with it until the operator fixes its permissions or billing in the dashboard; Baseten's shared Model APIs do not list Glimmer, but do list Meta's Muse Spark Open at Muse Spark's price, US$1.25 in and US$4.25 out per million tokens, text and image in) (to be stored in the vault as "IsItLegit Baseten", D99 T01 §7). Baseten serves Glimmer only as a dedicated deployment (`meta-models/Muse-Glimmer-30B`, BF16 on one H100, OpenAI-compatible, US$0.10833 per GPU minute), so it is scaled to zero between the daily runs and its cost is GPU time, not tokens.

## Inputs

- Design spec 4.11 (monitor screening), 9 (model map), 11 (Budget: Glimmer US$10); stack doc "Open-weight model" (Baseten first as a dedicated deployment, Together AI serverless as fallback, OpenAI-compatible; **Corrected 2026-10-27:** was Fireworks AI first).
- Meta docs `muse-glimmer.md`, `open-weight-models.md`; cookbook `meta-models/meta-oss-cookbook/muse-glimmer` (look up with `python3 scripts/meta-docs.py find glimmer`).

## Outcome

- `screenPage(screenshot, text)` returns a structured "brand lure with login or payment form" judgement from the configured screener (Muse Spark by default), with cost recorded.
- `docs/frontier-log.md` records Spark's baseline on the monitor's synthetic page set, and Glimmer's agreement with it and cost per page once the provider works.

**Adjacency:** all=not-applicable (internal screening step for the monitor; results are shown through monitor findings, D05 T04 §5)

**Adjacency rationale:** Glimmer screening only feeds the monitor pipeline.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Glimmer provider client with its budget | D03 T01 §2 | [ ] |
| 2 | §2 | Page screener on Muse Spark | D03 T02 §3 | [ ] |
| 3 | §3 | Glimmer measured against Spark | §1, §2 | [ ] |

## 1. Glimmer provider client with its budget

An OpenAI-compatible client pointed at the provider's base URL with `GLIMMER_PROVIDER_API_KEY`, the provider's Glimmer model ID recorded at setup, and the US$10 cap enforced by the D03 T01 budget guard with provider `glimmer`.

**Phase:** 6
**Needs:** third-party
**Surface:** no

**Build order:**

1. Record the provider and model ID. Done when: `src/meta/glimmer.ts` names the provider base URL and model ID with the docs URL they came from.
2. Route calls through the budget guard. Done when: a stubbed test reserves and settles against the `glimmer` cap.

- [ ] Confirm a Baseten credit balance on the account's billing page before deploying (without it every GPU minute is charged to the card; record it in D99 T01 §7), then deploy Muse Glimmer on Baseten with autoscaling to zero and the shortest scale-down delay Baseten allows, and record its deployment model ID, base URL, the AI Gateway Baseten route and the per-minute price (US$0.10833 per H100 minute) in `src/meta/glimmer.ts` with the provider's docs URL; the US$10 guard counts GPU minutes (deploy, scale and run time) from Baseten's usage, not tokens. Done when: the constants exist and one call through AI Gateway answers; until the key exists this section keeps `third-party` in Needs. (**Corrected 2026-10-27:** was "Fireworks first" with per-token prices; Baseten serves Glimmer only as a dedicated deployment.)
- [ ] Write `glimmerChat(request, ctx)` using the `openai` SDK with the provider base URL and key, structured output if the provider supports it, else JSON mode with zod validation. Done when: `test/meta/glimmer.test.ts` checks the request with a stubbed transport.
- [ ] Reserve and settle through `budget.ts` with provider `glimmer` and the US$10 total cap. Done when: the cap test refuses the call past US$10.
- [ ] Commit: `meta: Glimmer provider client with its budget`

**Test checkpoint:** `pnpm exec vitest run test/meta/glimmer.test.ts` passes.

## 2. Page screener on Muse Spark

One screening interface for the monitor: it gets the page screenshot and visible text (untrusted) and answers whether the page is a brand lure with a login or payment form. It ships with Muse Spark, so the monitor (D05 T04 §3) never waits on a hosted provider; §3 may swap in Glimmer later. **Corrected 2026-10-27 (operator: a Fireworks issue must not stop development):** this section compared Glimmer with Spark and so needed the provider; the comparison is now §3.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `screenPage` with the `PageScreen` schema and a Spark implementation. Done when: a stubbed test returns the judgement.
2. Measure Spark on 40 synthetic pages. Done when: `docs/frontier-log.md` has Spark's baseline and `MONITOR_SCREENER` is `spark`.

- [ ] Define `PageScreen` (`brand`, `has_login_form`, `has_payment_form`, `lure` boolean, `confidence`) and write `screenPage(image, text, screener)` with the text in an untrusted block, dispatching to a `spark` implementation through the Meta client (D03 T01). Done when: `test/vision/screen.test.ts` passes with a stubbed Spark transport, and an unknown screener is refused.
- [ ] Build 40 synthetic candidate pages (20 lures with fictional brands, 20 benign) under `eval/sets/monitor-pages/`. Done when: the set and labels exist.
- [ ] Screen the set with Spark, recording accuracy, misses, latency and cost per page in `docs/frontier-log.md`. Done when: the Spark row exists.
- [ ] Set `MONITOR_SCREENER = "spark"` with the reason "Glimmer not yet measured (D03 T04 §3)". Done when: the constant and its reason are committed.
- [ ] Commit: `vision: page screener on Muse Spark with its baseline`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and `grep -c 'Spark' docs/frontier-log.md` prints at least `1`.

## 3. Glimmer measured against Spark

The same 40 pages screened by Glimmer through the §1 client; agreement, misses, latency and cost per page sit beside Spark's row, and the monitor switches to Glimmer only if it misses no lure Spark finds on the set (else Spark stays, spec 4.11 cut order). This is the only part of the monitor that waits on the provider.

**Phase:** 6
**Needs:** meta-api, third-party
**Surface:** no

**Build order:**

1. Add the `glimmer` implementation behind `screenPage`. Done when: the stubbed test covers both screeners.
2. Compare on the 40 pages. Done when: `docs/frontier-log.md` has the Glimmer row and the chosen screener.

- [ ] Add a `glimmer` implementation of `screenPage` through `glimmerChat` (§1). Done when: `test/vision/screen.test.ts` covers `spark` and `glimmer` with stubbed transports.
- [ ] Screen the §2 set with Glimmer, recording accuracy, misses, latency and cost per page beside Spark's row in `docs/frontier-log.md`. Done when: the table has both rows.
- [ ] Set `MONITOR_SCREENER` to `glimmer` only if it missed no lure Spark found, else keep `spark`, with the reason. Done when: the constant and its reason are committed.
- [ ] Commit: `vision: Glimmer screening measured against Spark`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and `grep -c 'Glimmer' docs/frontier-log.md` prints at least `1`.

## Verification

- Glimmer screens pages inside its own budget, and the choice of screener rests on a recorded comparison.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
