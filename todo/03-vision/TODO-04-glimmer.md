---
schema_version: 1
id: glimmer
domain: 03-vision
status: active
title: "TODO-04 -- Muse Glimmer Screening Through a Hosted Provider"
track: day-6
---

# TODO-04 -- Muse Glimmer Screening Through a Hosted Provider

> **Goal:** Muse Glimmer (open weights, 30B, text and image in) screens the impersonation monitor's candidate pages cheaply through a hosted provider (Fireworks AI first), inside its own US$10 budget, and the cost and accuracy per page against Muse Spark are measured and recorded.

> **Current state:** Measured 2026-10-26 20:00 SAST. No provider account or key yet (D99 T01 §7). Glimmer is not on the Meta Model API (spec 9).

## Inputs

- Design spec 4.11 (monitor screening), 9 (model map), 11 (Budget: Glimmer US$10); stack doc "Open-weight model" (Fireworks AI first, OpenRouter or Together as fallback, OpenAI-compatible).
- Meta docs `muse-glimmer.md`, `open-weight-models.md`; cookbook `meta-models/meta-oss-cookbook/muse-glimmer` (look up with `python3 scripts/meta-docs.py find glimmer`).

## Outcome

- `screenPage(screenshot, text)` returns a structured "brand lure with login or payment form" judgement from Glimmer, within budget, with cost recorded.
- `docs/frontier-log.md` records Glimmer's agreement with Muse Spark and cost per page on the monitor's synthetic page set.

**Adjacency:** all=not-applicable (internal screening step for the monitor; results are shown through monitor findings, D05 T04 §5)

**Adjacency rationale:** Glimmer screening only feeds the monitor pipeline.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Glimmer provider client with its budget | D03 T01 §2 | [ ] |
| 2 | §2 | Page screening compared with Spark | §1, D03 T02 §3 | [ ] |

## 1. Glimmer provider client with its budget

An OpenAI-compatible client pointed at the provider's base URL with `GLIMMER_PROVIDER_API_KEY`, the provider's Glimmer model ID recorded at setup, and the US$10 cap enforced by the D03 T01 budget guard with provider `glimmer`.

**Phase:** 6
**Needs:** third-party
**Surface:** no

**Build order:**

1. Record the provider and model ID. Done when: `src/meta/glimmer.ts` names the provider base URL and model ID with the docs URL they came from.
2. Route calls through the budget guard. Done when: a stubbed test reserves and settles against the `glimmer` cap.

- [ ] Confirm which provider serves Muse Glimmer with the partner credit recorded in D99 T01 §7 (Fireworks first), and record base URL, model ID and per-token prices in `src/meta/glimmer.ts` with the provider's docs URL. Done when: the constants exist; until the key exists this section keeps `third-party` in Needs.
- [ ] Write `glimmerChat(request, ctx)` using the `openai` SDK with the provider base URL and key, structured output if the provider supports it, else JSON mode with zod validation. Done when: `test/meta/glimmer.test.ts` checks the request with a stubbed transport.
- [ ] Reserve and settle through `budget.ts` with provider `glimmer` and the US$10 total cap. Done when: the cap test refuses the call past US$10.
- [ ] Commit: `meta: Glimmer provider client with its budget`

**Test checkpoint:** `pnpm exec vitest run test/meta/glimmer.test.ts` passes.

## 2. Page screening compared with Spark

Glimmer gets the page screenshot and visible text (untrusted) and answers whether it is a brand lure with a login or payment form. The same 40 synthetic pages are screened by Glimmer and by Muse Spark; agreement, misses and cost per page are recorded, and the monitor uses Glimmer only if it misses no lure Spark finds on the set (else Spark screens a smaller list, spec 4.11 cut order).

**Phase:** 6
**Needs:** meta-api, third-party
**Surface:** no

**Build order:**

1. Write `screenPage` with the `PageScreen` schema. Done when: a stubbed test returns the judgement.
2. Compare with Spark on 40 synthetic pages. Done when: `docs/frontier-log.md` has the table and the chosen screener.

- [ ] Define `PageScreen` (`brand`, `has_login_form`, `has_payment_form`, `lure` boolean, `confidence`) and write `screenPage(image, text)` calling Glimmer with the text in an untrusted block. Done when: `test/vision/screen.test.ts` passes.
- [ ] Build 40 synthetic candidate pages (20 lures with fictional brands, 20 benign) under `eval/sets/monitor-pages/`. Done when: the set and labels exist.
- [ ] Screen the set with Glimmer and Spark, recording accuracy, misses, latency and cost per page in `docs/frontier-log.md`. Done when: the table exists.
- [ ] Set `MONITOR_SCREENER` to Glimmer or Spark from the result. Done when: the constant and its reason are committed.
- [ ] Commit: `vision: page screening with Glimmer measured against Spark`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and `grep -c 'Glimmer' docs/frontier-log.md` prints at least `1`.

## Verification

- Glimmer screens pages inside its own budget, and the choice of screener rests on a recorded comparison.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
