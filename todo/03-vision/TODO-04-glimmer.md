---
schema_version: 1
id: glimmer
domain: 03-vision
status: active
title: "TODO-04 -- Page Screening on Muse Glimmer with Muse Spark Failover"
track: day-6
---

# TODO-04 -- Page Screening on Muse Glimmer with Muse Spark Failover

> **Goal:** The impersonation monitor screens candidate pages through one `screenPage` interface: Muse Glimmer 30B on Fireworks AI serverless first (through AI Gateway; the chat completions endpoint, which keeps no prompt or output data for open models, never the Responses API, which keeps conversations 30 days), and Muse Spark in Standard mode on the Meta Model API (`store: false`, the Meta client and AI Gateway) whenever Fireworks fails, times out, rate-limits or reaches its cap, so a Fireworks outage never stops the monitor. Cheap enough for its daily volume: Glimmer at US$0.35 and US$1.50 a million input and output tokens, well under a cent a page. **Corrected 2026-10-28 (operator decision, 09:05 SAST):** Fireworks' US$100 partner credit is loaded, so the 2026-10-27 removal is reversed and Glimmer on Fireworks is the screener again, with Spark (the 2026-10-27 screener) as its failover. Lookalike pages copy real people's details, the reason the Contributor plan was withdrawn; Fireworks' serverless retains none of it (its data-handling documentation), which this file proves before the first real page. The earlier Goal, kept for the record: The impersonation monitor screens candidate pages through one `screenPage` interface on Muse Spark (Standard mode, `store: false`, through the Meta client and AI Gateway), cheaply enough for its daily volume: about US$0.005 a page, cents a day for tens of new or changed pages. **Corrected 2026-10-27 (operator decisions):** this file planned Muse Glimmer through a hosted provider (Fireworks, then Baseten); at 10:47 SAST the operator removed the outside providers in favour of Muse Spark 1.3 Contributor, and at 11:05 SAST chose Standard Muse Spark instead, because lookalike pages copy real people's names, addresses and numbers and Meta forbids personal data in Contributor input. The rule "Standard model IDs only, never `-contributor`" (`AGENTS.md`) stands unchanged.

> **Current state:** Measured 2026-10-28 09:15 SAST. No screening code exists. The Meta Model API key is in the vault ("IsItLegit Meta Model API"); calls go through AI Gateway `isitlegit` (D00 T01 §6, which has a `custom-meta` route). Fireworks' US$100 credit is loaded (operator, 09:02 SAST); the vault items "IsItLegit Fireworks" (an inference-only service account's key, the Worker's `FIREWORKS_API_KEY`) and "IsItLegit Fireworks Admin" (local scripts only) are empty placeholders until the operator fills them. Fireworks lists Muse Glimmer 30B (`accounts/fireworks/models/muse-glimmer-30b`, image input, 131K context) and Muse Spark Open (serverless preview until 2026-10-29, the same price as Spark on Meta); whether Glimmer is on serverless or only on dedicated deployments is checked with the key before any call. History: on 2026-10-27 the Fireworks account had no credit and Baseten's covered only Muse Spark Open; neither was used.

## Inputs

- Design spec 4.8 (Meta data terms: Standard model IDs only), 4.11 (monitor screening), 9 (model map), 11 (budget: Fireworks US$90 in total and US$5 a day).
- Fireworks AI documentation: data handling (zero retention for open models on serverless, the Responses API's 30-day exception), serverless pricing, the Muse Glimmer 30B model page.

## Outcome

- `screenPage(screenshot, text, ctx)` returns a structured "brand lure with login or payment form" judgement from Muse Glimmer on Fireworks, or from Muse Spark when Fireworks fails or reaches its cap, naming which answered, with its cost recorded against the monitor run that asked.
- `docs/frontier-log.md` records Glimmer's and Spark's accuracy, misses, latency and cost per page on the monitor's synthetic page set, side by side.

**Adjacency:** all=not-applicable (internal screening step for the monitor; results are shown through monitor findings, D05 T04 §5)

**Adjacency rationale:** Screening only feeds the monitor pipeline.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Glimmer screener, Spark failover | D03 T02 §3 | [ ] |

## 1. Glimmer screener, Spark failover

One screening interface for the monitor: it gets the page screenshot and visible text (untrusted) and answers whether the page is a brand lure with a login or payment form, on Muse Glimmer 30B on Fireworks first and Muse Spark on the Meta Model API when Fireworks cannot answer. **Corrected 2026-10-28 (operator decision, 09:05 SAST):** was "Page screener on Muse Spark", Spark alone; Glimmer on Fireworks returns as the first screener and Spark becomes its failover. **Corrected 2026-10-27:** was §2, beside a Glimmer client (§1) and a Glimmer comparison (§3), both removed with the outside providers; the screening happens before any case exists, so its cost belongs to the monitor run.

**Phase:** 6
**Needs:** meta-api, third-party
**Surface:** no

`third-party` is the Fireworks key: it is removed once the vault items "IsItLegit Fireworks" and "IsItLegit Fireworks Admin" have filled credential fields (checked by count only, never the value).

**Build order:**

1. Confirm what Fireworks serves and route it through AI Gateway. Done when: the key lists Glimmer as serverless and a gateway call returns.
2. Write `screenPage` with the `PageScreen` schema on Glimmer, failing over to Spark. Done when: stubbed tests cover Glimmer's answer and each failover cause.
3. Measure both on 40 synthetic pages. Done when: `docs/frontier-log.md` has a Glimmer row and a Spark row.

- [ ] With the admin key in a local script (`scripts/fireworks-check.ts`, never in the Worker), list the account's models and credit and record in `docs/frontier-log.md` whether `accounts/fireworks/models/muse-glimmer-30b` is on serverless, its price, and the credit left; refuse to create a dedicated deployment (billed by the hour against the credit) without the operator's written decision. Done when: the record names Glimmer's serving mode and price, and `test/node/fireworks-check.test.ts` shows the script never calls a deployment-creating endpoint. Source: Fireworks' model page lists on-demand deployments, and the serverless rate comes from third-party listings.
- [ ] Add a `custom-fireworks` provider route to AI Gateway `isitlegit` next to `custom-meta` (D00 T01 §6), and put `FIREWORKS_API_KEY` as a Wrangler secret from the vault item "IsItLegit Fireworks" (never printed). Done when: the gateway config test (`test/node/gateway-config.test.ts`) lists the route and a live one-token Glimmer call through it returns, its cost logged.
- [ ] Define `PageScreen` (`brand`, `has_login_form`, `has_payment_form`, `lure` boolean, `confidence`, `screener` of `glimmer` or `spark`) and write `screenPage(image, text, ctx)` in `src/vision/screen.ts`: Glimmer through the Fireworks chat completions endpoint (never the Responses API) with a JSON schema response format, the text in an untrusted block, and `ctx` naming the monitor run and the candidate host so cost and gateway metadata belong to that run, not a case (D03 T01 §3). Done when: `test/vision/screen.test.ts` passes with a stubbed Glimmer transport, finds the run and host on the call, and refuses an answer that does not fit the schema.
- [ ] Fail over to `muse-spark-1.3` through `metaResponses` (D03 T01 §1) when the Glimmer call errors, times out (10 seconds), is rate-limited, returns an answer outside the schema, or the Fireworks cap is reached, recording which screener answered and why the first did not. Done when: the test makes each of those happen and gets Spark's judgement with the reason, and a run with both failing returns a typed failure the monitor records rather than a guess.
- [ ] Enforce the Fireworks cap in code: US$90 in total of the US$100 credit and US$5 a day, counted from each response's token usage at the listed rates, beside the Meta budget guard in `src/meta/` (design spec section 11). Done when: a test at the daily cap sends the next page to Spark without calling Fireworks, and the Admin overview's Fireworks bars (`design/SPEC.md`, model spend against caps) read the same counts.
- [ ] Build 40 synthetic candidate pages (20 lures with fictional brands, 20 benign) under `eval/sets/monitor-pages/`. Done when: the set and labels exist.
- [ ] Screen the set with Glimmer and with Spark, recording each one's accuracy, misses, latency and cost per page in `docs/frontier-log.md`. Done when: both rows exist; if Glimmer misses more lures than Spark, the record says so and the operator decides which screens first.
- [ ] Commit: `vision: page screener on Muse Glimmer with Muse Spark failover`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and fails if Glimmer's failure is not answered by Spark or the Fireworks cap is ignored, and `grep -cE 'Glimmer|Spark' docs/frontier-log.md` prints at least `2`.

## Verification

- The monitor screens pages on Muse Glimmer on Fireworks, falls over to Muse Spark in Standard mode, and records each page's screener and cost.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
