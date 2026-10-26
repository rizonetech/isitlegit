---
schema_version: 1
id: vision-pipeline
domain: 03-vision
status: active
title: "TODO-02 -- Rendering, Muse Spark Reading and Brand Domains"
track: day-3
---

# TODO-02 -- Rendering, Muse Spark Reading and Brand Domains

> **Goal:** Each email is rendered to a screenshot the way the recipient saw it (scripts off, remote images allowed inside the sandbox), PDF pages become images, and Muse Spark reads the rendered email and pages as structured evidence (claimed brand, requested action, urgency cues, visible sender identity); a claimed brand is checked against its real domains from the curated table, then from Muse Spark search grounding with citations for brands not in the table.

> **Current state:** Measured 2026-10-26 20:00 SAST. The model client (D03 T01), Browser Run binding and link checks (D02 T07) are planned before this file.

## Inputs

- Design spec 4.4 (visual analysis), 4.6a (untrusted content), 9 (model map: `muse-spark-1.3` with image input and JSON-schema output; search grounding).
- Meta docs `image-understanding.md`, `file-handling.md`, `structured-output.md`, `search-grounding.md` (look up with `python3 scripts/meta-docs.py find <terms>`).

## Outcome

- The fictional-bank phishing fixture's report shows "Shows <Fictional Bank> branding; sent from a domain <Fictional Bank> does not use (source: brand table)" with the rendered screenshot as its artefact.
- A brand missing from the table is answered by search grounding with a cited source URL, or the item says the brand's domains could not be confirmed.

**Adjacency:** all=not-applicable (evidence producers; shown on the report, D07 T03 §3)

**Adjacency rationale:** Rendering and model reading only add evidence and artefacts to a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Email HTML rendering to a screenshot | D02 T07 §2, D02 T05 §1 | [ ] |
| 2 | §2 | PDF page rasterisation | §1 | [ ] |
| 3 | §3 | Muse Spark structured reading of renders and pages | §1, D03 T01 §6 | [ ] |
| 4 | §4 | Claimed brand against its real domains | §3, D02 T03 §3 | [ ] |

## 1. Email HTML rendering to a screenshot

The member saw a rendered email, not HTML source. Browser Run renders the email HTML with scripts disabled and remote images allowed inside the sandbox (spec 4.4), at a desktop and a phone width.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Write `renderEmail(caseId)` in `src/vision/render.ts`. Done when: the fixture produces two PNGs in R2.

- [ ] Load the parsed HTML into a Browser Run page with JavaScript disabled, inline `cid:` images resolved from the stored attachments, remote images allowed, downloads blocked (reuse D02 T07 §2 interception). Done when: `test/vision/render.test.ts` renders the fixture.
- [ ] Capture full-page PNGs at 1024 and 390 px widths, capped at 6000 px tall, stored as `render` artefacts. Done when: both files exist with dimensions recorded.
- [ ] Render plain-text-only mail as a simple monospace page so every case has an image. Done when: the text-only fixture renders.
- [ ] Commit: `vision: email rendering to screenshots`

**Test checkpoint:** `pnpm exec vitest run test/vision/render.test.ts` passes.

## 2. PDF page rasterisation

PDF attachments become page images for SAM and for the report's evidence cards; Muse Spark also reads PDFs natively (spec 4.4, 4.5). `pdfjs-dist` runs inside the Browser Run page.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Rasterise the first 5 pages of each PDF attachment. Done when: a 3-page synthetic invoice yields 3 PNGs.

- [ ] Load `pdfjs-dist` 6.4.299 in the page and render pages at 1600 px width to PNG `page` artefacts. Done when: `test/vision/pdf-pages.test.ts` reads three images.
- [ ] Refuse encrypted or malformed PDFs with a typed error that becomes an info evidence item. Done when: a damaged PDF fixture yields the item, not a crash.
- [ ] Commit: `vision: PDF page rasterisation`

**Test checkpoint:** `pnpm exec vitest run test/vision/pdf-pages.test.ts` passes.

## 3. Muse Spark structured reading of renders and pages

Muse Spark reads the rendered email (and PDF pages) as images plus the visible text in an untrusted block, and returns a structured view: claimed brand, requested action (log in, pay, open file, call, reply with details, none), urgency cues with quotes, visible sender identity (spec 4.4).

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Define the schema and the call. Done when: a stubbed test turns a model reply into evidence items.
2. Run it live on three fixtures. Done when: results, latency and cost are recorded in `docs/frontier-log.md`.

- [ ] Define `MailReading` in `src/vision/reading-schema.ts` (`claimed_brand` nullable, `requested_action` enum, `urgency_cues` array of short quotes, `visible_sender`, `payment_request` boolean, `confidence`). Done when: `z.toJSONSchema` output is non-recursive.
- [ ] Call `muse-spark-1.3` through `structured()` with the desktop render as `input_image` (base64 data URL) and `visible.txt` inside `untrusted("email")`. Done when: `test/vision/reading.test.ts` checks the request has the image, the untrusted block and `store: false`.
- [ ] Turn the reading into evidence `vision.claimed_brand`, `vision.requested_action` (high for log in or pay with urgency), `vision.urgency`. Done when: the stub reply yields the three items.
- [ ] Cache by render SHA-256 and prompt version (D03 T01 §4). Done when: a second identical case makes no model call.
- [ ] Run it on three synthetic fixtures after the credit gate and record results in `docs/frontier-log.md`. Done when: the entry exists.
- [ ] Commit: `vision: Muse Spark structured reading`

**Test checkpoint:** `pnpm exec vitest run test/vision/reading.test.ts` passes and fails if the visible text is sent outside the untrusted block.

## 4. Claimed brand against its real domains

A claimed brand is checked against its real domains: the curated table first, then Muse Spark search grounding with citations for brands not in the table (spec 4.4). The finding names the source.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Register `brand.domain_mismatch`. Done when: a fixture claiming a table brand from another domain yields it with the table as source.
2. Add search grounding for unknown brands. Done when: a stubbed grounded answer with a citation yields the item with the cited URL.

- [ ] Look up the claimed brand with `getBrand` (D02 T03 §3) and register `brand.domain_mismatch` (high when the sender or landing domain is not one of the brand's domains). Done when: `test/vision/brand.test.ts` passes for the fictional bank fixture.
- [ ] For a brand not in the table, call `muse-spark-1.3` with search grounding (`https://dev.meta.ai/docs/search-grounding`) asking for the brand's official domains, requiring at least one citation from the brand's own site, and cache the answer 30 days. Done when: a stubbed grounded reply produces the item with `detail.source_url`; a reply without a citation yields "could not be confirmed". Cheaper substitute: trusting the model's answer without a citation.
- [ ] Count grounding calls against the budget at US$2.50 per 1,000 searches plus tokens. Done when: the spend row records it.
- [ ] Commit: `vision: claimed brand against its real domains`

**Test checkpoint:** `pnpm exec vitest run test/vision/brand.test.ts` passes and fails if an uncited grounded answer is accepted.

## Verification

- Rendered screenshots, page images and Spark readings appear as evidence with artefacts; brand mismatches cite their source.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
