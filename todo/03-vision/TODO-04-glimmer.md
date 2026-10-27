---
schema_version: 1
id: glimmer
domain: 03-vision
status: active
title: "TODO-04 -- Public-Page Screening on Muse Spark Contributor"
track: day-6
---

# TODO-04 -- Public-Page Screening on Muse Spark Contributor

> **Goal:** The impersonation monitor screens candidate pages through one `screenPage` interface that ships with Muse Spark (Standard mode), and Muse Spark 1.3 Contributor (`muse-spark-1.3-contributor`, US$0.10 in and US$0.20 out per million tokens, the cheapest Meta model; Standard Muse Spark is US$1.25 and US$4.25) replaces it there once a recorded comparison shows it misses no lure Spark finds. Contributor-mode input may be used for training and must contain no personal data, so it only ever sees a public page's screenshot and visible text with a generic question; the brand comparison for a flagged page stays in Standard mode (the full pipeline, spec 4.4). **Corrected 2026-10-27 (operator decision, 10:47 SAST):** this file planned Muse Glimmer through a hosted provider (Fireworks, then Baseten); the operator replaced the outside providers with Muse Spark 1.3 Contributor, the cheapest option, and removed Baseten and Fireworks from the plan.

> **Current state:** Measured 2026-10-27 10:47 SAST. No screening code exists. The Meta Model API key is in the vault ("IsItLegit Meta Model API"); calls go through AI Gateway `isitlegit` (D00 T01 §6), which prices `muse-spark-1.3-contributor`. History: a Fireworks account had no credit; Baseten's credit covered only Muse Spark Open and is not used.

## Inputs

- Design spec 4.8 (Meta data terms: Contributor content may be used for training and must not contain personal data), 4.11 (monitor screening), 9 (model map), 11 (budget); `AGENTS.md` (the one permitted Contributor model and where it may be named).
- Meta docs on Muse Spark and its Contributor mode (`https://dev.meta.ai/docs/pricing-rate-limits`; look up with `python3 scripts/meta-docs.py find contributor`).

## Outcome

- `screenPage(screenshot, text)` returns a structured "brand lure with login or payment form" judgement from the configured screener (Muse Spark by default, Muse Spark Contributor once measured), with cost recorded.
- `docs/frontier-log.md` records Spark's baseline on the monitor's synthetic page set, and Contributor's agreement with it and cost per page.

**Adjacency:** all=not-applicable (internal screening step for the monitor; results are shown through monitor findings, D05 T04 §5)

**Adjacency rationale:** Contributor screening only feeds the monitor pipeline.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Contributor client for public pages | D03 T01 §2 | [ ] |
| 2 | §2 | Page screener on Muse Spark | D03 T02 §3 | [ ] |
| 3 | §3 | Contributor measured against Spark | §1, §2 | [ ] |

## 1. Contributor client for public pages

The one place that calls `muse-spark-1.3-contributor`: a client that accepts only a public page's screenshot and visible text, asks a generic question that names no member or protected business, and goes through the Meta client (D03 T01) and its budget guard like every other Meta call. **Corrected 2026-10-27 (operator decision):** was the Glimmer provider client with its own US$10 budget.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write the client with an input that cannot carry member data. Done when: a stubbed test sends exactly the page's screenshot and text with `store: false`.
2. Keep the model ID in this one file. Done when: the repository guard (D03 T01 §1) refuses the ID anywhere else.

- [ ] Write `screenPublicPage({ url, screenshot, visibleText }, ctx)` in `src/meta/contributor.ts`, calling `muse-spark-1.3-contributor` through `metaResponses` (D03 T01 §1) with `store: false`, the generic prompt "Is this page a brand lure with a login or payment form?", the page text in an untrusted block, and nothing else: no member, organisation, protected brand, mail or case content (its type has no field for them). Done when: `test/meta/contributor.test.ts` checks the request body with a stubbed gateway and finds only those parts.
- [ ] Refuse a non-public input: the URL must be `https:` on a host outside the member's own domains and outside any address the case came from, and the screenshot must come from Browser Run's render of that URL. Done when: the test refuses a member-domain URL and a screenshot without its render reference.
- [ ] Reserve and settle through `budget.ts` (D03 T01 §2) under the Meta caps, priced by the gateway's `muse-spark-1.3-contributor` rule (US$0.10, US$0.002 cached, US$0.20 per million tokens). Done when: the cap test refuses a call past the daily cap.
- [ ] Commit: `meta: Contributor screening client for public pages`

**Test checkpoint:** `pnpm exec vitest run test/meta/contributor.test.ts` passes and fails if any member or case field reaches the request.

## 2. Page screener on Muse Spark

One screening interface for the monitor: it gets the page screenshot and visible text (untrusted) and answers whether the page is a brand lure with a login or payment form. It ships with Muse Spark in Standard mode, so the monitor (D05 T04 §3) works from day one; §3 swaps in Contributor once measured.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `screenPage` with the `PageScreen` schema and a Spark implementation. Done when: a stubbed test returns the judgement.
2. Measure Spark on 40 synthetic pages. Done when: `docs/frontier-log.md` has Spark's baseline and `MONITOR_SCREENER` is `spark`.

- [ ] Define `PageScreen` (`brand`, `has_login_form`, `has_payment_form`, `lure` boolean, `confidence`) and write `screenPage(image, text, screener)` with the text in an untrusted block, dispatching to a `spark` implementation through the Meta client (D03 T01). Done when: `test/vision/screen.test.ts` passes with a stubbed Spark transport, and an unknown screener is refused.
- [ ] Build 40 synthetic candidate pages (20 lures with fictional brands, 20 benign) under `eval/sets/monitor-pages/`. Done when: the set and labels exist.
- [ ] Screen the set with Spark, recording accuracy, misses, latency and cost per page in `docs/frontier-log.md`. Done when: the Spark row exists.
- [ ] Set `MONITOR_SCREENER = "spark"` with the reason "Contributor not yet measured (D03 T04 §3)". Done when: the constant and its reason are committed.
- [ ] Commit: `vision: page screener on Muse Spark with its baseline`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and `grep -c 'Spark' docs/frontier-log.md` prints at least `1`.

## 3. Contributor measured against Spark

The same 40 pages screened by Muse Spark Contributor through the §1 client; agreement, misses, latency and cost per page sit beside Spark's row, and the monitor switches to Contributor only if it misses no lure Spark finds on the set (else Spark stays, spec 4.11 cut order). **Corrected 2026-10-27 (operator decision):** was Glimmer measured against Spark.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Add the `contributor` implementation behind `screenPage`. Done when: the stubbed test covers both screeners.
2. Compare on the 40 pages. Done when: `docs/frontier-log.md` has the Contributor row and the chosen screener.

- [ ] Add a `contributor` implementation of `screenPage` through `screenPublicPage` (§1). Done when: `test/vision/screen.test.ts` covers `spark` and `contributor` with stubbed transports.
- [ ] Screen the §2 set with Contributor, recording accuracy, misses, latency and cost per page beside Spark's row in `docs/frontier-log.md`. Done when: the table has both rows.
- [ ] Set `MONITOR_SCREENER` to `contributor` only if it missed no lure Spark found, else keep `spark`, with the reason. Done when: the constant and its reason are committed.
- [ ] Commit: `vision: Contributor screening measured against Spark`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and `grep -c 'Contributor' docs/frontier-log.md` prints at least `1`.

## Verification

- Contributor screens only public pages, with no member data in any request, and the choice of screener rests on a recorded comparison.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
