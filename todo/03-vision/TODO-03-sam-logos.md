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

> **Started:** 2026-10-31T09:45:14Z

Comparison needs reference logos. Real brands' logos are used only as detection references stored privately in R2, never committed to the public repository and never imitated on our pages (design spec section 11 Fixtures). Each entry records where it was taken from.

**Phase:** 4
**Needs:** cloudflare
**Surface:** no

> **Corrected 2026-10-31:** measured on the 23 brands of `data/brands.json` (probe 2026-10-31 11:45 SAST): almost no brand publishes a site icon of 256 px or more (most stop at a 180 px `apple-touch-icon` or a `favicon.ico`), and Open Graph images are mostly marketing photos or product icons, not the logo; one brand answers a bot-check page to a plain fetch. The logo a phishing mail copies is the wordmark in the site header. The primary source is therefore the header logo of the brand's own home page, rendered in headless Chromium (`scripts/lib/chromium.ts`, `playwright-core`) and screenshotted as a PNG at device scale 2; a 256 px or larger manifest icon, `link rel=icon` or Open Graph image is the fallback, recorded as such. A curated selector table, `data/reference-logos.json` (slug, page URL, CSS selector, the source kind), makes the capture repeatable, and every captured logo is looked at before it is loaded. The capture lands outside the repository in `~/isitlegit-data/reference-logos/` (lane data rule, `AGENTS.md` Parallel lanes), never in git. The R2 key is `ref/logos/<slug>.png` (a raster fallback that is not PNG keeps its own extension, `.jpg` or `.webp`, types the Meta Model API accepts). The checkpoint ran `pnpm exec tsx`; the repository runs TypeScript scripts with `node` (no `tsx` dependency), so it is `node scripts/load-reference-logos.ts`. At least 20 of the 23 brands must load; a brand that cannot be captured is listed in the index's `missing` array with the reason, never silently dropped.

> **Corrected 2026-10-31 (coordinator, 11:45 SAST):** the logos go into the production `isitlegit-artefacts` bucket under `ref/logos/`, but this section never writes production: it builds and tests against Wrangler's local R2 (`--local`) and hands the coordinator the exact `--remote` commands (dry run and real) and the list of objects they write; the coordinator runs them at the next operator-approved deploy, like a migration. Lifecycle rules read 2026-10-31 (`wrangler r2 bucket lifecycle list isitlegit-artefacts`): `raw-30-days` (prefix `raw/`), `smoke-1-day` (prefix `smoke/`) and the default multipart-abort rule (all prefixes, incomplete uploads only); none expires objects under `ref/`, so the store is kept. Every logo is the brand's own published mark, held privately for comparison and never served publicly; its source URL is recorded.

**Build order:**

1. Capture each brand's logo from its own website into the local store. Done when: `~/isitlegit-data/reference-logos/<slug>.png` exists for at least 20 brands, each looked at.
2. Load the store into R2 with provenance. Done when: `ref/logos/<slug>.png` and `ref/logos/index.json` (source URL, fetch date, dimensions, source kind) are in local R2, and the coordinator has the production commands.

- [ ] Write `data/reference-logos.json`: one entry per brand of `data/brands.json` (slug, home page URL on one of the brand's own domains, CSS selector of the header logo, `kind` `header` or `icon` or `og`). Done when: `test/node/reference-logos.test.ts` checks every entry names a brand of the table, its URL's registrable domain is one of that brand's `domains`, and slugs are unique kebab-case. Cheaper substitute: a URL that is not the brand's own domain.
- [ ] Write the pure parts of `scripts/load-reference-logos.ts`: `imageInfo(bytes)` reads media type and dimensions from PNG, JPEG and WebP headers and refuses anything else (SVG, ICO, HTML); `logoKey(slug, type)` builds `ref/logos/<slug>.<ext>` and refuses a slug outside `[a-z0-9-]`; `LogoIndex` is a zod schema (`version`, `generated_at`, `logos[]` with slug, brand, key, source URL, source kind, fetch date, width, height, sha256, `fictional`; `missing[]` with slug and reason). Done when: the test reads real PNG, JPEG and WebP headers from bytes it builds, refuses an SVG and an HTML page served as `image/png`, refuses `../x` as a slug, and the schema refuses an entry under 256 px on its longer side. Cheaper substitute: trusting the server's `Content-Type`.
- [ ] Write `capture`: for each entry, open the page in headless Chromium at 1440 by 900, device scale 2, take an element screenshot of the selector (or fetch the fallback image for `icon` and `og`), check it with `imageInfo`, and write `<slug>.<ext>` and `index.json` into the local store through a temporary file then rename; a brand that fails is recorded under `missing` with its reason and the run goes on. Done when: a run against the live sites stores at least 20 logos and an index listing every brand either under `logos` or `missing`. Cheaper substitute: a full-page screenshot.
- [ ] Write `load --local|--remote [--dry-run]`: upload each indexed logo with `wrangler r2 object put isitlegit-artefacts/<key> --file <path> --content-type <type>`, then `index.json` last, and read the index back whole; refuse a key outside `ref/logos/`; `--dry-run` prints every command and object and writes nothing. Done when: the test, with a stubbed Wrangler runner, sees one put per logo, the index put last, a refusal for a key outside `ref/logos/`, a non-zero exit when a put or the read-back fails, and no put at all under `--dry-run`. Cheaper substitute: writing the index before the logos.
- [ ] Write `--check [--local|--remote]`: read `ref/logos/index.json` from R2, validate it with `LogoIndex`, confirm each listed key exists, print `reference logos: <n> in R2 (<m> missing)` and exit 0 only when `n >= 20`. Done when: the test exits 1 for an index of 19 logos and for a listed key that is absent.
- [ ] Add fictional-brand reference logos for Protea Bank (fictional bank) and NimbusMail (fictional mail provider), drawn as SVG and rendered to PNG at 512 px, under `test/fixtures/brands/` with `test/fixtures/brands/README.md` saying they are fictional and IsItLegit's own work; `capture` copies them into the store with `fictional: true`. Done when: both PNGs exist, the test reads them with `imageInfo` at 256 px or more, and the index marks them fictional.
- [ ] Run `capture`, look at every logo, then `load --local`. Done when: the checkpoint below prints at least 20 and exits 0.
- [ ] Hand the coordinator the production load: the exact `node scripts/load-reference-logos.ts load --remote --dry-run` and `load --remote` commands, `--check --remote` to confirm, and the list of keys they write, sent once the local load passes (before the stamp, which needs this item ticked) and recorded in `docs/phase-runs/2026-10-31-walkthrough-phase-4.md`. Done when: the message is sent and the run file lists the keys.
- [ ] Commit: `vision: reference logo store`

**Test checkpoint:** `node scripts/load-reference-logos.ts --check --local` prints `reference logos: <n> in R2` with `n` at least 20 and exits 0; `pnpm exec vitest run test/node/reference-logos.test.ts` passes, and fails if `imageInfo` accepts an SVG or `--check` passes 19 logos.

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
