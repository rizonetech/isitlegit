---
schema_version: 1
id: sam-logos
domain: 03-vision
status: active
title: "TODO-03 -- SAM 3.1 Logo Segmentation and Comparison"
track: day-4
---

# TODO-03 -- SAM 3.1 Logo Segmentation and Comparison

> **Goal:** SAM 3.1 finds logos, stamps and signatures in rendered emails, landing pages and document pages; each crop is stored and compared by Muse Spark with the claimed brand's reference logo (or a protected business's registered logo) for a same or different judgement; logo recall is measured on synthetic samples and the fallback to Muse Spark perception grounding is taken if SAM misses logos.

> **Current state:** Measured 2026-10-26 20:00 SAST. No SAM code exists. Logo detection quality on rendered email is undocumented (spec 4.4, risks table).

## Inputs

- Design spec 4.4 (SAM 3.1 "logo" prompt, `@meta-sam/parser`, fallback), 8 (risk: SAM recall), 9 (model map); `sources/meta-api/2026-10-26-meta-model-api.md` section 3 (SAM request and output grammar).
- Meta docs `sam/segmenting.md`, `media-segmentation.md`, `image-understanding.md` (perception grounding).
- -> XREF: D05 T02 §2 -- counterparty claim detection compares logos with the registered logo through this file

## Outcome

- A synthetic email showing a fictional bank's logo from the wrong domain yields "logo matches <Fictional Bank>; sender is not <Fictional Bank>" with the crop as artefact.
- `docs/frontier-log.md` records SAM's logo recall on 20 synthetic samples and which detector the product uses.

**Adjacency:** list=not-applicable (no records of its own to find; results appear on each case); document=not-applicable (produces no document a user carries or files); settings=not-applicable (no tunables; limits are fixed in code with the spec reference); reporting=applicable @ D08 T02 §3; notifications=not-applicable (sends no notices of its own); permissions=not-applicable (no user action to permit or refuse); audit=not-applicable (changes are code commits; per-case activity is in case events); exchange=applicable @ D03 T03 §2; reverse=not-applicable (pure checks)

**Adjacency rationale:** The reference logo store is imported reference data (§2); the eval measures SAM's contribution by ablation (D08 T02 §3). Everything else is evidence on a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | SAM 3.1 client, parser and crops | D03 T02 §1, D03 T01 §5 | [ ] |
| 2 | §2 | Reference logo store in R2 | D02 T03 §3 | [ ] |
| 3 | §3 | Logo comparison by Muse Spark | §1, §2 | [ ] |
| 4 | §4 | Logo recall check and detector choice | §3 | [ ] |

## 1. SAM 3.1 client, parser and crops

`sam-3.1` is served over the Responses API with one `input_text` concept prompt and one `input_image` (spec 4.4). Output is special-token text decoded with `@meta-sam/parser` 0.1.0; boxes become PNG crops in R2.

**Phase:** 4
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `segment(image, concept)` in `src/vision/sam.ts`. Done when: a recorded SAM response parses into boxes in a test.
2. Crop and store. Done when: each box becomes a `crop` artefact.

- [ ] Add exact dependency `@meta-sam/parser` 0.1.0 and confirm it loads in the workers pool (ESM). Done when: a test imports it.
- [ ] Call `metaResponses({ model: "sam-3.1", input: [{ role: "user", content: [{ type: "input_text", text: concept }, { type: "input_image", image_url }] }], metadata: { include_confidence: "true", mask_encoding: "one_bit" } })` (Meta docs `sam/segmenting`). Done when: `test/vision/sam.test.ts` checks the request shape.
- [ ] Parse `output_text` with the parser and keep boxes with confidence at least 0.4, at most 8 per image. Done when: a recorded response yields the expected boxes.
- [ ] Crop each box with 8 px padding from the source PNG (Workers image decode via `@cf-wasm/photon` or Browser Run canvas, choose one and record why) and store `crop` artefacts. Done when: the crops exist with dimensions.
- [ ] Run concepts `logo`, `stamp` and `signature` on renders and PDF pages (one concept per request, spec 4.4 prompt rules). Done when: three requests are made per image in the test.
- [ ] Commit: `vision: SAM 3.1 segmentation and crops`

**Test checkpoint:** `pnpm exec vitest run test/vision/sam.test.ts` passes and fails if two concepts are sent in one request.

## 2. Reference logo store in R2

Comparison needs reference logos. Real brands' logos are used only as detection references stored privately in R2, never committed to the public repository and never imitated on our pages (design spec section 11 Fixtures). Each entry records where it was taken from.

**Phase:** 4
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Fetch each brand's logo from its own website into R2. Done when: `ref/logos/<brand>.png` exists for the brand table's brands.
2. Record provenance. Done when: `ref/logos/index.json` in R2 lists source URL and fetch date per logo.

- [ ] Write `scripts/load-reference-logos.ts` reading `data/brands.json`, fetching each brand's logo from its own site (Open Graph image or site icon at 256 px or more), and storing `ref/logos/<slug>.png` in R2 (never in git). Done when: a run stores at least 20 logos.
- [ ] Write `ref/logos/index.json` in R2 with slug, source URL, fetch date and dimensions. Done when: the index lists every stored logo.
- [ ] Add fictional-brand reference logos (generated for the demo and eval, committed under `test/fixtures/brands/`) for the fictional bank and mail provider. Done when: they exist and are marked fictional.
- [ ] Commit: `vision: reference logo store`

**Test checkpoint:** `pnpm exec tsx scripts/load-reference-logos.ts --check` prints the count of logos in R2 (at least 20) and exits 0.

## 3. Logo comparison by Muse Spark

SAM finds; Muse Spark judges (Meta's own advice: pair them). Each crop is sent with the claimed brand's reference logo, or a protected business's registered logo, for a structured same or different judgement with a reason (spec 4.4).

**Phase:** 4
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Register `vision.logo_match`. Done when: stubbed replies for same and different yield the right evidence.

- [ ] Define `LogoJudgement` (`same_brand` boolean, `brand_seen`, `differences` array, `confidence`). Done when: the schema is used with `structured()`.
- [ ] Send the crop and the reference as two `input_image` parts with a fixed prompt; cache by both hashes. Done when: `test/vision/logo-compare.test.ts` checks the request.
- [ ] Register `vision.logo_match`: high when the logo matches a brand and the sender or landing domain is not that brand's; info when brand and domain agree. Done when: the fixture pair yields high.
- [ ] Commit: `vision: logo comparison by Muse Spark`

**Test checkpoint:** `pnpm exec vitest run test/vision/logo-compare.test.ts` passes.

## 4. Logo recall check and detector choice

SAM's logo quality on rendered email is unknown (risks table). This section measures recall on 20 synthetic branded emails and, if SAM finds fewer than 16 of 20 logos, switches detection to Muse Spark perception grounding (boxes from the vision model), recording why.

**Phase:** 4
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Build the 20-sample set and measure recall. Done when: `docs/frontier-log.md` records recall and cost.
2. Choose the detector. Done when: `src/vision/detector.ts` uses the chosen one and the decision is recorded.

- [ ] Generate 20 synthetic branded emails with fictional brands at varied sizes and positions (`scripts/fixtures/make-branded.ts`) with labelled logo boxes. Done when: the set and labels exist under `eval/sets/logo-recall/`.
- [ ] Measure SAM recall (box IoU at least 0.5) and record it with cost and latency in `docs/frontier-log.md`. Done when: the entry exists.
- [ ] Implement perception grounding with `muse-spark-1.3` (boxes on a normalised grid, Meta docs `image-understanding`) behind the same interface and measure it on the same set. Done when: both numbers are recorded.
- [ ] Set `DETECTOR` in `src/vision/detector.ts` to the better one (SAM unless recall is under 16 of 20) and note the decision in design spec section 8 risks row. Done when: the constant and the note exist.
- [ ] Commit: `vision: logo recall measured and detector chosen`

**Test checkpoint:** `pnpm exec vitest run test/vision/detector.test.ts` passes and `grep -c 'logo recall' docs/frontier-log.md` prints at least `1`.

## Verification

- Logo crops and judgements appear as evidence; the detector choice is measured and recorded.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
