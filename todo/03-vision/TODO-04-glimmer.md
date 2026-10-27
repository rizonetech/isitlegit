---
schema_version: 1
id: glimmer
domain: 03-vision
status: active
title: "TODO-04 -- Page Screening on Muse Spark"
track: day-6
---

# TODO-04 -- Page Screening on Muse Spark

> **Goal:** The impersonation monitor screens candidate pages through one `screenPage` interface on Muse Spark (Standard mode, `store: false`, through the Meta client and AI Gateway), cheaply enough for its daily volume: about US$0.005 a page, cents a day for tens of new or changed pages. **Corrected 2026-10-27 (operator decisions):** this file planned Muse Glimmer through a hosted provider (Fireworks, then Baseten); at 10:47 SAST the operator removed the outside providers in favour of Muse Spark 1.3 Contributor, and at 11:05 SAST chose Standard Muse Spark instead, because lookalike pages copy real people's names, addresses and numbers and Meta forbids personal data in Contributor input. The rule "Standard model IDs only, never `-contributor`" (`AGENTS.md`) stands unchanged.

> **Current state:** Measured 2026-10-27 11:05 SAST. No screening code exists. The Meta Model API key is in the vault ("IsItLegit Meta Model API"); calls go through AI Gateway `isitlegit` (D00 T01 §6). History: a Fireworks account had no credit; Baseten's credit covered only Muse Spark Open and is not used.

## Inputs

- Design spec 4.8 (Meta data terms: Standard model IDs only), 4.11 (monitor screening), 9 (model map), 11 (budget).

## Outcome

- `screenPage(screenshot, text, ctx)` returns a structured "brand lure with login or payment form" judgement from Muse Spark, with its cost recorded against the monitor run that asked.
- `docs/frontier-log.md` records Spark's accuracy, misses, latency and cost per page on the monitor's synthetic page set.

**Adjacency:** all=not-applicable (internal screening step for the monitor; results are shown through monitor findings, D05 T04 §5)

**Adjacency rationale:** Screening only feeds the monitor pipeline.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Page screener on Muse Spark | D03 T02 §3 | [ ] |

## 1. Page screener on Muse Spark

One screening interface for the monitor: it gets the page screenshot and visible text (untrusted) and answers whether the page is a brand lure with a login or payment form, on Muse Spark. **Corrected 2026-10-27:** was §2, beside a Glimmer client (§1) and a Glimmer comparison (§3), both removed with the outside providers; the screening happens before any case exists, so its cost belongs to the monitor run.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `screenPage` with the `PageScreen` schema on Spark. Done when: a stubbed test returns the judgement.
2. Measure Spark on 40 synthetic pages. Done when: `docs/frontier-log.md` has Spark's row.

- [ ] Define `PageScreen` (`brand`, `has_login_form`, `has_payment_form`, `lure` boolean, `confidence`) and write `screenPage(image, text, ctx)` on `muse-spark-1.3` through `metaResponses` (D03 T01 §1), with the text in an untrusted block and `ctx` naming the monitor run and the candidate host, so the call's cost and gateway metadata belong to that run rather than to a case (D03 T01 §3). Done when: `test/vision/screen.test.ts` passes with a stubbed Spark transport and finds the run and host on the request.
- [ ] Build 40 synthetic candidate pages (20 lures with fictional brands, 20 benign) under `eval/sets/monitor-pages/`. Done when: the set and labels exist.
- [ ] Screen the set with Spark, recording accuracy, misses, latency and cost per page in `docs/frontier-log.md`. Done when: the Spark row exists.
- [ ] Commit: `vision: page screener on Muse Spark with its baseline`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes and `grep -c 'Spark' docs/frontier-log.md` prints at least `1`.

## Verification

- The monitor screens pages on Muse Spark in Standard mode, and its cost per page is recorded.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
