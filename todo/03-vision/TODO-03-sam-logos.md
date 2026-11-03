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
| 1 | §1 | SAM 3.1 client, parser and crops | D03 T02 §1, D03 T01 §5 | [x] |
| 2 | §2 | Reference logo store in R2 | D02 T03 §3 | [x] |
| 3 | §3 | Logo comparison by Muse Spark | §1, §2 | [x] |
| 4 | §4 | Logo recall check and detector choice | §3 | [x] |
| 5 | §5 | Logos for blocked brands and variants | §2, §4 | [ ] |
| 6 | §6 | Ablation flag in segmentation | §1, D04 T01 §14 | [x] |
| 7 | §7 | Compared reference in logo_match detail | §3 | [x] |

## 1. SAM 3.1 client, parser and crops

> **Started:** 2026-11-02T03:05:41Z

> **Corrected 2026-11-02 (walkthrough lane, plan validation against the tree):** (1) Checklist item 3 as written calls `metaResponses`, but the correction below already establishes the non-streamed parse cannot work: the request goes through the streaming call item 2 adds, and item 3 is rewritten to say so. (2) The crop runs on a Browser Run canvas (`page.evaluate` with the PNG as a blob URL, `drawImage` on the padded box, `canvas.toBlob`): every caller that segments already launches Browser Run (the vision step), so no new dependency or WASM bundle is added; `@cf-wasm/photon` stays the alternative if a browserless caller appears, at the cost of a new recorded dependency then. (3) Boxes are read from the parsed stream's records (`parseImageStream` to `finalResult`, `recordsOfKind(records, "box")`, half-open source pixels, optional `confidence`), not from `output_text`; item 4 is rewritten to say so.

> **Corrected 2026-11-02 (plan review, gaps 1 to 6):** (1) Stream outcomes are typed: `segment()` distinguishes a completed stream (zero matches is an empty list, not an error) from an incomplete stream, a refusal, parser error diagnostics and a transport failure, each a typed `SegmentError` kind; in the step these become coverage losses, never "no logos found" and never a case failure. (2) The vision step is the integration point: after it buffers the selected images it runs segmentation per image with its own browser and the step deadline, storing crops that name their source image and concept; segmentation failure joins the reading's coverage losses before the commit. (3) Crops clip the padded half-open box to the source bounds, validate coordinates against the decoded image size, and store through `putArtefact`; the test decodes actual pixels of a distinctive synthetic image (edge boxes included), reads back stored bytes and metadata, and a retry stores the same crop references without duplicate rows (artefact keys are content-addressed). (4) The crop operation is bounded end to end (decode, canvas evaluation, storage), releases its page and blob URLs on every path, never closes the caller's browser, fences its writes after expiry, and a stalled crop loses that image's crops, not the next image's. (5) Selection: a box with no confidence is kept (absence is not zero) and sorts below any box with one; order is deterministic (concept order `logo`, `stamp`, `signature`, then confidence descending, then record order); the 0.4 threshold applies when confidence is present; at most 8 boxes per image across all concepts. (6) The streaming transport's tests prove fragmented events, an interrupted or stalled stream, a retryable HTTP failure, a budget refusal and failed-attempt accounting, with the deadline covering stream consumption and settlement after consumption; they join the Test checkpoint.

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) `@meta-sam/parser` 0.1.0 is already a dependency (`package.json`), so the first step is only to confirm it loads in the workers pool. (2) `sam-3.1` is already registered (`src/meta/models.ts`, US$2.50 per 1,000 images) and the smoke test passed (`docs/meta-smoke-test.md`). SAM answers as a stream: `scripts/meta-smoke.ts` reads it to `response.completed` and parses it with `parseImageStream`, while `ResponsesParams` in `src/meta/client.ts:109` omits `stream`, so `segment()` needs a streaming call added beside `metaResponses` (same ledger, retry and `store: false` rules), not a parse of a non-streamed `output_text`. Confirm `include_confidence` and `mask_encoding` against `sam/segmenting.md` before relying on them. (3) The Meta docs mirror is `~/isitlegit/sources/meta-api/docs/docs/sam/segmenting.md`; one concept per request is confirmed there. (4) `crop` is already in `DERIVED_KINDS`. (5) `@cf-wasm/photon` is not installed; choose between it and a Browser Run canvas and record why, as the section says.

`sam-3.1` is served over the Responses API with one `input_text` concept prompt and one `input_image` (spec 4.4). Output is special-token text decoded with `@meta-sam/parser` 0.1.0; boxes become PNG crops in R2.

**Phase:** 4
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `segment(image, concept)` in `src/vision/sam.ts`. Done when: a recorded SAM response parses into boxes in a test.
2. Crop and store. Done when: each box becomes a `crop` artefact.

- [x] Confirm `@meta-sam/parser` 0.1.0 (already in `package.json`) loads in the workers pool (ESM). Done when: a test imports it.
- [x] Add a streaming `segment` call beside `metaResponses` in `src/meta/client.ts` (same ledger, retry and `store: false`) and use it for the request below. Done when: `test/meta/client.test.ts` shows a streamed answer read to `response.completed`.
- [x] Call the streaming segment call with `{ model: "sam-3.1", input: [{ role: "user", content: [{ type: "input_text", text: concept }, { type: "input_image", image_url }] }], metadata: { include_confidence: "true", mask_encoding: "one_bit" }, stream: true, store: false }` (Meta docs `sam/segmenting`; the correction of 2026-11-02 above). Done when: `test/vision/sam.test.ts` checks the request shape.
- [x] Parse the stream with `parseImageStream` to its `finalResult` and keep boxes (`recordsOfKind(records, "box")`) with confidence at least 0.4, at most 8 per image. Done when: a recorded response yields the expected boxes.
- [x] Crop each box with 8 px padding from the source PNG on a Browser Run canvas (the choice and reason in the correction of 2026-11-02 above) and store `crop` artefacts. Done when: the crops exist with dimensions.
- [x] Run concepts `logo`, `stamp` and `signature` on renders and PDF pages (one concept per request, spec 4.4 prompt rules). Done when: three requests are made per image in the test.
- [x] Type the stream outcomes in `segment()`: a completed stream with no records returns an empty list; an incomplete stream, a refusal, parser error diagnostics and a transport failure each throw a `SegmentError` kind. Done when: `test/vision/sam.test.ts` proves each, and none is reported as no logos found.
- [x] Apply the selection contract: keep boxes at confidence at least 0.4 when confidence is present, keep a box with no confidence (absence is not zero) sorted below any with one, deterministic order (concept order, confidence descending, record order), at most 8 boxes per image across all concepts. Done when: the test covers absent confidence, the 0.4 boundary and more than eight eligible boxes across concepts.
- [x] Bound the crop operation in `src/vision/sam.ts`: clip the padded box to the decoded bounds, typed failures for decode, null `toBlob`, browser and storage failure, page and blob URLs released on every path, the caller's browser never closed, writes fenced after expiry, and a stalled crop loses only its own image. Done when: the test decodes actual crop pixels of a distinctive synthetic image (an edge box included), covers a stalled crop beside a successful next image, and reads back the stored bytes and metadata.
- [x] Wire segmentation into `visionStep` in `src/vision/step.ts`: after the selected images are buffered, run the three concepts per image with the step's browser and deadline, store each crop through `putArtefact` naming its source image and concept, and join any segmentation failure to the reading's coverage losses before the commit. Done when: a case-level test (`test/vision/step-read.test.ts`) processes a render and a PDF page through this path and reads back their crops, with a stubbed SAM failure stated as coverage and no case failure.
- [x] Prove the streaming transport in `test/meta/client.test.ts`: fragmented events, an interrupted or stalled stream, a retryable HTTP failure, a budget refusal and failed-attempt accounting, the deadline covering stream consumption and settlement after it. Done when: those tests pass beside the existing client tests.
- [x] Commit: `vision: SAM 3.1 segmentation and crops`

**Test checkpoint:** `pnpm exec vitest run test/vision/sam.test.ts` passes and fails if two concepts are sent in one request; `pnpm exec vitest run test/meta/client.test.ts` passes its streaming cases.

> **Verified:** 2026-11-02 | §1 | 2a365bb4a217f040e5576ce9f598b3e631b1e81c
> **Review:** `docs/reviews/d03-t03-s1.json`

## 2. Reference logo store in R2

> **Started:** 2026-10-31T09:45:14Z

Comparison needs reference logos. Real brands' logos are used only as detection references stored privately in R2, never committed to the public repository and never imitated on our pages (design spec section 11 Fixtures). Each entry records where it was taken from.

**Phase:** 4
**Needs:** cloudflare
**Surface:** no

> **Corrected 2026-10-31:** measured on the 23 brands of `data/brands.json` (probe 2026-10-31 11:45 SAST): almost no brand publishes a site icon of 256 px or more (most stop at a 180 px `apple-touch-icon` or a `favicon.ico`), and Open Graph images are mostly marketing photos or product icons, not the logo; one brand answers a bot-check page to a plain fetch. The logo a phishing mail copies is the wordmark in the site header. The primary source is therefore the header logo of the brand's own home page, rendered in headless Chromium (`scripts/lib/chromium.ts`, `playwright-core`) and screenshotted as a PNG at device scale 2; a 256 px or larger manifest icon, `link rel=icon` or Open Graph image is the fallback, recorded as such. A curated selector table, `data/reference-logos.json` (slug, page URL, CSS selector, the source kind), makes the capture repeatable, and every captured logo is looked at before it is loaded. The capture lands outside the repository in `~/isitlegit-data/reference-logos/` (lane data rule, `AGENTS.md` Parallel lanes), never in git. The R2 key is `ref/logos/<slug>.png` (a raster fallback that is not PNG keeps its own extension, `.jpg` or `.webp`, types the Meta Model API accepts). The checkpoint ran `pnpm exec tsx`; the repository runs TypeScript scripts with `node` (no `tsx` dependency), so it is `node scripts/load-reference-logos.ts`. At least 20 of the 23 brands must load; a brand that cannot be captured is listed in the index's `missing` array with the reason, never silently dropped.

> **Corrected 2026-10-31 (coordinator, 11:45 SAST):** the logos go into the production `isitlegit-artefacts` bucket under `ref/logos/`, but this section never writes production: it builds and tests against Wrangler's local R2 (`--local`) and hands the coordinator the exact `--remote` commands (dry run and real) and the list of objects they write; the coordinator runs them at the next operator-approved deploy, like a migration. Lifecycle rules read 2026-10-31 (`wrangler r2 bucket lifecycle list isitlegit-artefacts`): `raw-30-days` (prefix `raw/`), `smoke-1-day` (prefix `smoke/`) and the default multipart-abort rule (all prefixes, incomplete uploads only); none expires objects under `ref/`, so the store is kept. Every logo is the brand's own published mark, held privately for comparison and never served publicly; its source URL is recorded.

> **Corrected 2026-10-31 (plan review, P1 and P2 findings 1 to 5):** the use basis is recorded: design spec section 11 (Fixtures, decided 2026-10-26) allows real brands only as private R2 detection references, never imitated or shown; `NOTICE.md` gets a row for the store stating that basis (each mark is its owner's trademark, taken from the owner's own site, held privately only to recognise impersonation of that owner, never served, redistributed or committed), and each index entry carries `use: "detection-reference"` and its source; a logo whose page is not on one of its brand's own domains is refused and listed as missing. The count is of distinct real brands (at least 20 of 23), the two fictional references counted apart, every real brand exactly once across `logos` and `missing`. Loads are generation-based like `scripts/load-brands.ts`: logos go under `ref/logos/<generation>/` (the generation is the capture's UTC stamp), `ref/logos/index.json` names the live generation and is written last, the index it replaces is kept as `ref/logos/index.previous.json`, and `--restore` makes the previous one live again; earlier generations' objects are never overwritten. Every stored byte is verified: the files against the index before any put, the index read back whole after it, and `--check` downloads each object and compares its SHA-256, type and dimensions. Capture is bounded: 45 seconds per brand, the page closed on every path. Screenshots are taken at device scale 4 so a header logo of 64 CSS pixels or more reaches the 256 px floor.

> **Captured 2026-10-31:** generation `20261031T115449Z` (local store, loaded into local R2; it supersedes `20261031T105740Z`, taken before round 1's fixes): 20 real brands and both fictional references, each looked at on a contact sheet; Adobe and FedEx answer headless Chromium with a bot wall and DHL never finishes loading, so they are listed under `missing` with those reasons, and FNB, whose bot check passes about one load in two, was finished with `capture --into 20261031T115449Z`. The capture keeps each logo on its own header background (white marks such as Standard Bank's and SARS's need it), scales small vector marks by CSS transform, crosses into shadow DOM (PayPal), takes Chrome's own screenshot (`Page.captureScreenshot`), records the address of the document the logo came from after the shot, and refuses a logo that painted under 2% of its clip (Takealot's page often stays on its loading screen, so its own published logo, its Open Graph image on `static.takealot.com`, is the source). The production load was handed to the coordinator on 2026-10-31 (run file).

**Build order:**

1. Capture each brand's logo from its own website into the local store. Done when: `~/isitlegit-data/reference-logos/<generation>/` holds a validated logo (its key and extension from `imageInfo`) for at least 20 distinct real brands, each looked at, and both fictional references.
2. Load the store into R2 with provenance. Done when: the generation's logos and `ref/logos/index.json` (source URL, fetch date, dimensions, source kind, hash) are in local R2 and verified by `--check`, and the coordinator has the production commands.

- [x] Write `data/reference-logos.json`: one entry per brand of `data/brands.json` (slug, home page URL on one of the brand's own domains, CSS selector of the header logo, `kind` `header` or `icon` or `og`). Done when: `test/node/reference-logos.test.ts` checks every brand of the table has exactly one entry, every entry names a brand of the table, its URL's registrable domain is one of that brand's `domains`, and slugs are unique kebab-case. Cheaper substitute: a URL that is not the brand's own domain.
- [x] Write the pure parts of `scripts/load-reference-logos.ts`: `imageInfo(bytes)` reads media type and dimensions from PNG, JPEG and WebP headers and refuses anything else (SVG, ICO, HTML); `logoKey(generation, slug, type)` builds `ref/logos/<generation>/<slug>.<ext>` and refuses a slug outside `[a-z0-9-]` or a generation not in the stamp form; `LogoIndex` is a zod schema (`version`, `generation`, `generated_at`, `logos[]` with slug, brand, key, source URL, source kind, `use`, fetch date, width, height, media type, sha256, `fictional`; `missing[]` with slug and reason) whose refinement refuses an entry under 256 px on its longer side, a duplicate slug, a slug in both lists, and a key outside its generation. Done when: the test reads PNG, JPEG and WebP headers from bytes it builds, refuses an SVG and an HTML page, refuses `../x` as a slug, and the schema refuses each of the four. Cheaper substitute: trusting the server's `Content-Type`.
- [x] Write `coverage(index, brands)`: every real brand of `data/brands.json` exactly once across `logos` and `missing`, the real logos counted apart from the fictional ones. Done when: the test refuses an index that omits a brand or lists one twice, and counts 18 real plus 2 fictional as 18.
- [x] Write `capture`: for each entry, within 45 seconds, open the page in headless Chromium at 1440 by 900, device scale 4, take an element screenshot of the selector (or fetch the fallback image for `icon` and `og`), check it with `imageInfo`, refuse a final page URL off the brand's domains, and write `<slug>.<ext>` into a new generation folder of the local store; the page is closed on every path, a brand that fails is recorded under `missing` with its reason and the next brand goes on; `index.json` is written last through a temporary file then rename. The grab of one brand is injected, so the test drives it without a browser. Done when: the test shows a grab that throws, one that never answers and one that returns an SVG each land under `missing` while the next brand is stored, and a live run stores at least 20 real brands. Cheaper substitute: a full-page screenshot.
- [x] Write `load --local|--remote [--dry-run]`: verify every file against the index (hash, type, dimensions) before any put and refuse the load on a mismatch; put each logo of the generation with `wrangler r2 object put isitlegit-artefacts/<key> --file <path> --content-type <type>`, copy the live index to `ref/logos/index.previous.json`, put `ref/logos/index.json` last, and read it back whole and equal; refuse a key outside `ref/logos/`; `--dry-run` prints every command and object and writes nothing. Done when: the test, with a stubbed Wrangler runner, sees one put per logo, the previous index kept, the index put last, a refusal for a key outside `ref/logos/` and for an altered image file before any put, a non-zero exit when a put fails or the read-back differs, and no put at all under `--dry-run`. Cheaper substitute: writing the index before the logos.
- [x] Write `load --restore`: make `ref/logos/index.previous.json` live again, its generation's objects untouched. Done when: the test restores the previous index after a failed later load and a retried restore answers the same.
- [x] Write `--check [--local|--remote]`: read `ref/logos/index.json` from R2, validate it with `LogoIndex` and `coverage`, download each listed key and compare its SHA-256, type and dimensions with the index, print `reference logos: <n> brands in R2 (<f> fictional, <m> missing)` and exit 0 only when every object matches and `n >= 20`. Done when: the test exits 1 for 19 real brands, for 18 real plus 2 fictional, for a listed key that is absent and for an object whose bytes differ.
- [x] Add fictional-brand reference logos for Protea Bank (fictional bank) and NimbusMail (fictional mail provider), drawn as SVG and rendered to PNG at 512 px, under `test/fixtures/brands/` with `test/fixtures/brands/README.md` saying they are fictional and IsItLegit's own work; `capture` copies them into the generation with `fictional: true`. Done when: both PNGs exist, the test reads them with `imageInfo` at 256 px or more, and the index marks them fictional.
- [x] Add the `NOTICE.md` row for the reference logo store with the use basis above. Done when: the row exists and names `ref/logos/` and design spec section 11.
- [x] Run `capture`, look at every logo, then `load --local`. Done when: the checkpoint below prints at least 20 brands and exits 0.
- [x] Refuse, before any put, a generation that is not publishable (`publishable(index, brands)`: every brand accounted for, at least 20 real, both fictional references), so a `--only` or short capture never reaches R2 (completion review, gap 1). Done when: `test/node/reference-logos.test.ts` shows 19 real, 18 real plus fictional, a partial table and a missing fictional reference each refused with no Wrangler call.
- [x] Keep both tries of a brand inside one 45-second deadline (completion review, gap 2). Done when: the test shows a page that never answers ends in about one deadline with one try.
- [x] Load the newest complete generation by default and log each newer unfinished one it skips (completion review, gap 3). Done when: the test loads the earlier complete generation past an index-less newer one and logs the skip.
- [x] Print one progress line per brand step during `capture` (completion review, excellence 2). Done when: the test sees each brand's tries and outcome logged before the next brand answers.
- [x] Read the logo's provenance after the shot and refuse a page that moved during the capture (round 1, P1). Done when: the live Chromium test in `test/node/reference-logos.test.ts` refuses a page whose address changes while its logo is taken.
- [x] Read a fallback image with a 5 MiB cap as it arrives (`readCapped`, round 1, P2). Done when: the test gives up past the cap and on a declared length over it.
- [x] Print each Wrangler command under `--dry-run` (round 1, P3). Done when: the dry-run test sees one `wrangler r2 object put` line per logo with its target flag.
- [x] Refuse a logo that painted under 2% of its clip, re-shooting a late one for up to eight seconds (found by the recapture after round 1: Microsoft and Takealot were stored blank). Done when: the live test refuses an empty box and a faint one.
- [x] Decode every fallback image in Chromium and require the size its header claims, refusing anything over 8192 px a side (round 2, P1: a truncated PNG kept its header). Done when: the live test refuses a truncated file, a header claiming a size its pixels lack, and a 9000 px header, and takes a whole image. The two fallback logos of generation `20261031T115449Z` (Apple, Takealot) were decoded whole when the contact sheet was built.
- [x] Refuse a logo box over 8192 px at device scale before any screenshot is taken (round 3, P2). Done when: the live test refuses a 3000 CSS px wide logo with no shot made.
- [x] Finish a generation's missing brands with `capture --into <generation>`, never touching its logos (an intermittent bot check costs one brand's retry, not a full recapture). Done when: the test retries only the missing brand and leaves the stored files byte for byte.
- [x] Report a failed Wrangler command as a next step (`wranglerFailure`: sign-in, network, local disk, timeout, other), never echoing its output (completion review, excellence 3). Done when: the test covers each class and a failed put names it.
- [x] Hand the coordinator the production load: the exact `node scripts/load-reference-logos.ts load --remote --dry-run` and `load --remote` commands, `--check --remote` to confirm, `load --remote --restore` to reverse, and the list of keys they write, sent once the local load passes (before the stamp, which needs this item ticked) and recorded in `docs/phase-runs/2026-10-31-walkthrough-phase-4.md`. Done when: the message is sent and the run file lists the keys.
- [x] Commit: `vision: reference logo store`

**Test checkpoint:** `node scripts/load-reference-logos.ts --check --local` prints `reference logos: <n> brands in R2` with `n` at least 20 and exits 0; `pnpm exec vitest run test/node/reference-logos.test.ts` passes, and fails if `imageInfo` accepts an SVG, if `--check` passes 18 real plus 2 fictional, or if `load` puts the index before a logo.

> **Verified:** 2026-10-31 | §2 | 9d280075363935ed19ab26eb025c026fec1e8846
> **Review:** `docs/reviews/d03-t03-s2.json`

## 3. Logo comparison by Muse Spark

> **Started:** 2026-11-02T18:55:00Z


> **Corrected 2026-11-02 (plan validation against the tree):** (1) The live index is not `{ version, logos }` alone: `LogoIndex` in `scripts/load-reference-logos.ts` carries `generation`, `generated_at`, `logos[]` (slug, brand, key under `ref/logos/<generation>/`, media_type, sha256, fictional) and `missing[]`, and the Worker cannot import that Node script, so `src/vision/logo-reference.ts` defines its own strict zod schema for the fields it reads and refuses anything else. (2) The bucket is reached as `deps.store.bucket` (`Store` in `src/intake/store.ts`); reads are bounded (index and image byte caps, the index's own sha256 checked against the downloaded image) and a missing brand, missing index or mismatched bytes is a typed `LogoReferenceError`, never an empty image. (3) Integration is in `visionStep` (`src/vision/step.ts`) after the reading: the current crop manifest per source image (written by `storeCrops` in `src/vision/sam.ts`) names the stored crops; only `logo` concept crops of an image whose reading claims a brand are compared, each comparison is cached by both image hashes (`withCache`, task `vision.logo-comparison`), and a comparison failure states itself as coverage, never as a same or different judgement and never as a case failure. (4) Severity follows the compared domains the brand stage already computed for that picture: high when the logo is the brand's and a compared sender or landing domain is not that brand's, info when every compared domain is the brand's; with no compared domain the match is stated info with the domain unjudged, never high on the logo alone.

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) Evidence is written with `addEvidence(db, caseId, "vision", items)`; the `vision` producer is added to `LATER_PRODUCERS` in D03 T02 §3, which this section depends on through §1. (2) The Worker has no reader for the reference store: nothing in `src/` reads the `ref/logos/` keys that `scripts/load-reference-logos.ts` writes (its index is `ref/logos/index.json`, shape `{ version, logos }`). Add a small reader beside `src/vision/logo-compare.ts` that loads the index and a brand's image from the `ARTEFACTS` bucket, bounded and typed, with a test against the stored fixtures `test/fixtures/brands/`. (3) The domain test uses `brandForDomain` and `registrable()` in `src/checks/brands.ts`; the sender and landing domains come from the case's own parse and the walkthrough's pages.


> **Corrected 2026-11-02 (plan review, gaps 1 to 5, planned in):** (1) `vision.logo_match` joins `ATTEMPT_OWNED` in `src/vision/step.ts`, so a replay replaces the previous logo results while preserving the reading and brand evidence outside the set, and its items ride the existing fenced commits. (2) Comparisons run in their own bounded phase inside the step deadline with a commit reserve: late calls and writes are fenced, unfinished comparisons state themselves as coverage, and a stalled reference read or model call loses only its own comparison. (3) The exported comparison is `compareLogo(ctx, crop, reference)` in `src/vision/logo-compare.ts`, where `reference` is image bytes with their media type and a provenance label; it accepts PNG, JPEG and WebP and refuses SVG with a typed error, because the model takes raster images. Retrieval of a protected business's registered logo (and any SVG conversion) stays with its owner (D05 T02 §2 reads the identity's stored logo; conversion is filed there), and this section's reader covers the curated `ref/logos/` store. (4) A different judgement (`same_brand: false`) still writes a `vision.logo_match` item: info severity, a summary that the crop is not the brand's logo, the model's differences and the crop as artefact; it never clears the message and never states a domain judgement. (5) The checkpoint grows to the case level: `test/vision/step-read.test.ts` reads back logo evidence for same and different stubbed judgements on official and unrelated domains and with no compared domain, plus malformed output, a refused or missing or corrupt or oversized reference, budget exhaustion, and cache reuse with invalidation when either image changes.

SAM finds; Muse Spark judges (Meta's own advice: pair them). Each crop is sent with the claimed brand's reference logo, or a protected business's registered logo, for a structured same or different judgement with a reason (spec 4.4).

**Phase:** 4
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Register `vision.logo_match`. Done when: stubbed replies for same and different yield the right evidence.

- [x] Define `LogoJudgement` (`same_brand` boolean, `brand_seen`, `differences` array, `confidence`). Done when: the schema is used with `structured()`.
- [x] Read the reference logo from the `ARTEFACTS` bucket (`ref/logos/index.json` and the brand's image) in `src/vision/logo-reference.ts`. Done when: `test/vision/logo-reference.test.ts` loads a stored fixture and refuses a missing brand with a typed error.
- [x] Send the crop and the reference as two `input_image` parts with a fixed prompt; cache by both hashes. Done when: `test/vision/logo-compare.test.ts` checks the request.
- [x] Register `vision.logo_match`: high when the logo matches a brand and the sender or landing domain is not that brand's; info when brand and domain agree. Done when: the fixture pair yields high.
- [x] Export `compareLogo` from `src/vision/logo-compare.ts` taking a crop and a reference image (bytes, media type, provenance label), refusing SVG and unsupported types with a typed error. Done when: `test/vision/logo-compare.test.ts` compares a registered-style reference that is absent from the curated index.
- [x] Write the negative judgement as evidence: `same_brand: false` yields an info `vision.logo_match` item naming the differences and the crop, never a clearance. Done when: the test reads it back beside the same-brand cases.
- [x] Join `vision.logo_match` to `ATTEMPT_OWNED` and run comparisons in a bounded phase with a commit reserve in `src/vision/step.ts`. Done when: `test/vision/step-read.test.ts` shows a replay replacing logo results, a stalled comparison stated as coverage with the reading standing, and same and different judgements on official, unrelated and unjudged domains read back.
- [x] Commit: `vision: logo comparison by Muse Spark`

**Test checkpoint:** `pnpm exec vitest run test/vision/logo-compare.test.ts test/vision/logo-reference.test.ts test/vision/step-read.test.ts` passes, and fails if a replay keeps a stale logo item, if a stalled comparison takes the reading down, or if a different judgement is stated as a clearance.

> **Verified:** 2026-11-02 | §3 | 3f2dffa554a6d124b3d792162c2c957664b2aca6
> **Review:** `docs/reviews/d03-t03-s3.json`

## 4. Logo recall check and detector choice

> **Started:** 2026-11-02T19:45:00Z

> **Corrected 2026-11-02 (plan validation against the tree):** (1) `scripts/fixtures/make-branded.ts` and `eval/sets/logo-recall/` do not exist yet; this section creates both, drawing on `scripts/fixtures/make-brand-logos.ts` for fictional logo drawing. (2) The measurement runs live Meta calls (SAM `sam-3.1` and Muse Spark perception grounding on 20 samples each) through the shared spend ledger (`~/isitlegit-data/ledgers/meta-spend.json`); before any paid call the run states its cap and never raises it, and the measured cost and latency are recorded per detector. (3) `src/vision/detector.ts` does not exist yet; the interface it exposes is the one `segmentImage` in `src/vision/sam.ts` already implements (boxes for an image), so the vision step can take the chosen detector without a second segmentation path.


> **Corrected 2026-11-02 (plan review, gaps 1 to 4, planned in):** (1) The chosen detector is wired into `visionStep`: the step calls it instead of `segmentImage` directly, with case-level tests for both selections reading back crops, manifests and logo evidence, including a zero-match replay clearing the previous set. (2) Grounding replaces the `logo` concept alone; `stamp` and `signature` stay on SAM. Its normalised boxes are converted to source pixels against the decoded image size and validated, confidence is absent (kept, sorted below confident boxes, as `selectBoxes` already treats it), the existing box limits apply, and its failures become coverage losses that publish no late crops. (3) One deterministic policy: SAM stays unless its recall is under 16 of 20 and grounding's recall is higher; a tie keeps SAM, both under 16 keeps SAM with the shortfall recorded, and an incomplete run (a refused or failed sample) scores that sample as missed, never out of the denominator. (4) The runner renders each fixture through the product render path, ties labels to those exact pixels, scores the boxes production selection retains, and saves per-sample predictions, failures, costs and timings under `eval/sets/logo-recall/`; IoU boundaries and the published totals are recomputed from the saved results in the test.

SAM's logo quality on rendered email is unknown (risks table). This section measures recall on 20 synthetic branded emails and, if SAM finds fewer than 16 of 20 logos, switches detection to Muse Spark perception grounding (boxes from the vision model), recording why.

**Phase:** 7
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Build the 20-sample set and measure recall. Done when: `docs/frontier-log.md` records recall and cost.
2. Choose the detector. Done when: `src/vision/detector.ts` uses the chosen one and the decision is recorded.

- [x] Generate 20 synthetic branded emails with fictional brands at varied sizes and positions (`scripts/fixtures/make-branded.ts`) with labelled logo boxes. Done when: the set and labels exist under `eval/sets/logo-recall/`.
- [x] Measure SAM recall (box IoU at least 0.5) and record it with cost and latency in `docs/frontier-log.md`. Done when: the entry exists.
- [x] Implement perception grounding with `muse-spark-1.3` (boxes on a normalised grid, Meta docs `image-understanding`) behind the same interface in `src/vision/detector.ts` (`groundLogos`, validated conversion to source pixels, typed failures). Done when: `test/vision/detector.test.ts` proves the conversion and the request; the measured number is the next item's record.
- [x] Set `DETECTOR` in `src/vision/detector.ts` to the better one (SAM unless recall is under 16 of 20) and note the decision in design spec section 8 risks row. Done when: the constant and the note exist.
- [x] Wire the chosen detector into `visionStep` (`src/vision/step.ts`) behind `src/vision/detector.ts` (grounding for the `logo` concept alone when selected, SAM for every concept otherwise, stamp and signature always SAM). Done when: `test/vision/step-read.test.ts` reads back crops, manifests and logo evidence for both selections and a zero-match replay clears the previous set.
- [x] Score reproducibly: the runner saves per-sample predictions, failures, costs and timings, and the test recomputes the published recall from them (IoU at least 0.5, a failed or refused sample scored missed). Done when: `test/vision/detector.test.ts` covers the IoU boundary, non-square conversion, malformed geometry, empty success, refusal, budget exhaustion and timeout.
- [x] Commit: `vision: logo recall measured and detector chosen`

**Test checkpoint:** `pnpm exec vitest run test/vision/detector.test.ts` passes and `grep -c 'logo recall' docs/frontier-log.md` prints at least `1`.

> **Verified:** 2026-11-02 | §4 | 1f52d7681fa7b510e22a28780ab3d9d05a3f8228
> **Review:** `docs/reviews/d03-t03-s4.json`

## 5. Logos for blocked brands

> **Started:** 2026-11-02T21:45:00Z

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) The store holds 20 of the 23 brands plus the fictional ones; the `--check --local` line printed today therefore reads 20 real brands and the checkpoint's 23 is the target after the three are captured. (2) The `capture --only` flag and the selector table live in `scripts/load-reference-logos.ts`; read them before relying on the section's wording. (3) This section stays last: it needs §4's labelled set.

Filed 2026-10-31 from D03 T03 §2's completion review (out of scope there).
> **Parked 2026-11-02, updated 2026-11-03:** the variant build is done (measured 9 of 12 against 7 of 12 with no false matches; the index, loader, reader and step all carry variants, and the fictional store pair proves it). Only DHL remains: unreachable from this machine at the network layer (retried 2026-11-03 after merging main: every `dhl.com` page and logo asset fails in curl over HTTP/1.1 and HTTP/2 and in headless Chromium; the connection opens to Akamai and the stream stalls, while only `/favicon.ico` is served, so no page or asset content is reachable from this host at all). The section does not stamp while a full capture cannot list 23 brands; when a host that reaches `dhl.com` finishes the generation, the full capture, look and local load close it.

> **Progress 2026-11-02:** Adobe (blog.adobe.com, its red mark at 400 by 352 px) and FedEx (developer.fedex.com, its wordmark at 1284 by 360 px) are captured and looked at; the selector table carries both. DHL is unreachable from this machine (every `dhl.com` page fails at the network layer in curl over HTTP/1.1 and HTTP/2 and in headless Chromium, while other hosts answer), so the DHL capture waits on a host that can reach `dhl.com`; the generation it lands in must be completed there with `capture --into` on the same store.


> **Added 2026-11-02 (D03 T03 §4 completion review, G1 and G7):** the recall set's images are generated directly, not through the product email renderer, and every sample is one wordmark banner on white with no logo-free negatives, multiple-logo pages or difficult variants. This section (or a successor it names) widens the set through `renderEmail` and reports false detections separately before any detector claim is broadened. The store holds one reference per brand and 20 of the 23 brands of `data/brands.json`: Adobe and FedEx answer headless Chromium with a bot wall and DHL never finishes loading. A specialist logo service (Brandfetch, measured against in that review) offers every brand and several variants (wordmark, icon, light and dark). This section closes both gaps once §4 has measured whether variants help detection.

**Phase:** 7
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Capture the three missing brands from a source on their own domains that answers a browser (a press or brand page). Done when: a full capture lists no brand under `missing`.
2. Decide on variants from §4's measurements. Done when: the decision and its numbers are in `docs/frontier-log.md`.

- [ ] Find, for Adobe, DHL and FedEx, a page on one of each brand's own `domains` that shows the logo to headless Chromium, and record its URL and selector in `data/reference-logos.json`. Done when: `node scripts/load-reference-logos.ts capture --only "Adobe,DHL,FedEx"` stores all three, each looked at. Cheaper substitute: a logo from a third-party site.
- [x] Measure, with §4's labelled set, whether a second reference per brand (icon beside wordmark, or the dark variant) raises the logo match rate. Done when: `docs/frontier-log.md` records both rates and the choice.
- [x] If the measurement favours variants, extend `LogoIndex` in `scripts/load-reference-logos.ts` with a `variant` field and the selector table with one entry per variant. Done when: `test/node/reference-logos.test.ts` covers two variants of one brand and `coverage` still counts the brand once.
- [ ] Run a full capture, look at every logo, `load --local`, and hand the coordinator the production load as in §2. Done when: `node scripts/load-reference-logos.ts --check --local` prints 23 brands.
- [ ] Commit: `vision: reference logos for every brand and the chosen variants`

**Test checkpoint:** `node scripts/load-reference-logos.ts --check --local` prints `reference logos: 23 brands in R2` and exits 0; `pnpm exec vitest run test/node/reference-logos.test.ts` passes.

## 6. Ablation flag in segmentation

> **Started:** 2026-11-03T20:52:00Z

> **Corrected 2026-11-03 (plan validation against the tree):** (1) The vision step segments in `runVision` (`src/vision/step.ts`) by calling `imageSize`, `detectBoxes`, `selectBoxes`, `cropBoxes` and `storeCrops` (there is no function named `segmentPages`), and the Workflow calls `visionStep` in `src/pipeline/analysis-workflow.ts`. `VisionDeps` gains an optional `ablateFlag?: () => Promise<AblateFlag | null>`, wired in `src/pipeline/analysis-workflow.ts` as `() => ablateFlagFor(this.env.CACHE, orgId)` for the case's organisation (a rejected reader treated as null so a KV failure segments as today). (2) When `ablateFlag` returns `"no-sam"` (and only `"no-sam"`), the segmentation block in `src/vision/step.ts` is skipped before `imageSize`, `detectBoxes`, `cropBoxes` and `storeCrops` (no SAM `sam-3.1` request, no logo grounding request, no crop PNG or crop manifest written, and on a replay of a previously segmented case an empty crop manifest is not needed because the logo comparison stage is also skipped when `no-sam` is active so stale crops are never compared), while `readMail` still runs with `complete` reflecting only real picture losses (so `no-sam` does not mark the reading partial or prevent reading cache writes, nor does it emit `checked: false` which would cap a safe verdict as partial in `ruleVerdict`). (3) Instead of a `checked: false` loss, the vision step emits a `vision.coverage` info item with `detail: { ablated: "no-sam", complete: true, losses: [] }` (or if the case also had real picture losses, `coverageItem(losses)` carries `ablated: "no-sam"` alongside `checked: false, complete: false, losses`), summary stating that image segmentation was ablated for measurement.

> **Corrected 2026-11-03 (plan review, gaps 1 to 3, planned in):** (1) `test/vision/step.test.ts` exercises the Workflow's org-scoped KV wiring (`ablateFlagFor(env.CACHE, orgId)` on the case's `org_id`) across a flagged organisation (`ablate:<orgId> = "no-sam"`), an unflagged second organisation, and after removing the KV flag, proving that ablation applies only to the flagged organisation and clearing the flag restores segmentation. (2) `test/vision/step.test.ts` proves that under `no-sam`, `readMail` still runs and persists reading evidence (`vision.claimed_brand`, `vision.requested_action`, `vision.urgency`), caches whole readings so a twin case hits the reading cache without a second reading call, leaves `ruleVerdict` un-degraded on a safe whole picture (no `checked: false` on `vision.coverage`), and retains `checked: false, complete: false, ablated: "no-sam"` (and a partial safe rule verdict) when a real picture loss occurs alongside `no-sam`. (3) `test/vision/step.test.ts` replays a previously segmented case (with stored crops, manifests and `vision.logo_match` evidence) under `no-sam`, proving zero SAM, grounding or logo-comparison requests, zero new crop or manifest writes, and removal of the previous `vision.logo_match` evidence while reading and `vision.brand_domain_mismatch` items remain.

Filed 2026-11-02 from the coordinator's assignment for eval D08 T02 §3, on the shared reader of D04 T01 §14: for a `no-sam` case the vision step skips SAM segmentation entirely (no SAM call, no crops) and its coverage states the ablation, so the arm measures what the reading and the checks find without segmented crops.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Read the flag where the vision step decides to segment. Done when: a flagged case makes no SAM call and stores no crop.
2. State the ablation in the step's coverage. Done when: the case's evidence names it instead of a SAM failure.

- [x] Honour `no-sam` in the vision step's segmentation (`src/vision/step.ts`, wired in `src/pipeline/analysis-workflow.ts`) through `ablateFlagFor` (D04 T01 §14): `detectBoxes` and `storeCrops` are never called, the crop manifest and logo comparison work are skipped, and the `vision.coverage` item states `ablated: "no-sam"` (without `checked: false` when the picture was otherwise whole, so the reading and verdict are not treated as failed coverage). Done when: `test/vision/step.test.ts` shows (a) a flagged case with no SAM, grounding or comparison request in its fetch log, no crop artefacts, persisted reading evidence, reading cache reuse on a twin whole case, `vision.coverage` with `ablated: "no-sam"` and a non-partial safe `ruleVerdict`, (b) retained `checked: false, complete: false, ablated: "no-sam"` when a real picture loss occurs under `no-sam`, (c) a replay of a previously segmented case under `no-sam` making no SAM, grounding or comparison call, writing no new crop or manifest, and removing prior `vision.logo_match` items while keeping reading and brand items, and (d) KV-backed `ablate:<orgId>` isolation across two organisations, flag removal restoring segmentation, and other-flag or failed-reader cases segmenting as today.
- [x] Commit: `vision: ablation flag in segmentation`

**Test checkpoint:** `pnpm exec vitest run test/vision/step.test.ts` passes, and fails if a flagged case sends a SAM request.

> **Verified:** 2026-11-03 | §6 | c40f1017b20e9abc4e9f9b6386f3bb67cc44cd86
> **Review:** `docs/reviews/d03-t03-s6.json`

## 7. Compared reference in logo_match detail

> **Started:** 2026-11-03T03:17:42Z

Filed 2026-11-03 from the app lane's D07 T03 §14 plan review, relayed by the coordinator: a report card must draw the exact reference a crop was judged against, not the brand's current reference. The compared reference's store key and hash therefore ride in the `vision.logo_match` evidence detail; until this lands, the app card draws the brand's current reference beside the crop, labelled as the reference, with the stored differences carrying the comparison.

> **Corrected 2026-11-03 (plan review, gaps 1 to 3, planned in):** (1) The step proof reads back both identity fields against the seeded reference's digest, asserts the stubbed comparison request's second image is the seeded reference bytes, and proves an index advance to a new generation leaves stored evidence naming its compared generation until a replay compares against the new one. (2) The detail gains a validated consumer contract in `src/vision/logo-compare.ts`: a zod schema pair where compared items require both fields, not-compared items forbid both, an incomplete or malformed pair is refused, and a historical compared item written before this section parses as historical with no reference identity, never as compared-with-reference. (3) The consuming side is deferred to its owner below; this section ships the recorded identity and its validated reader only.

> **Corrected 2026-11-03 (merge with main, D03 T03 §5 variants):** §5 landed on main while this section was in review: the step now compares each stored variant in turn (wordmark first, a match on any variant speaks, otherwise the wordmark judgement). The identity recorded here is the variant that produced the judgement actually written, tracked beside the judgement in `src/vision/step.ts`; a crop compared against two variants records the matched one, or the wordmark when none matched.

> **Consumer handoff (owner D07 T03 §14, app lane; routed through the coordinator 2026-11-03):** the report card's use of the recorded identity (validated retrieval of the recorded key, hash verification before drawing, honest unavailable and historical-reference states, case-authorised access only, with tests that an index change cannot substitute another reference and a request cannot retrieve a reference outside the case's own evidence) is the app lane's build; the `XREF:` pair is wired when the app lane adds its pointer back, because a one-sided XREF refuses validation.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Record the compared reference in the judgement evidence. Done when: every `checked: true` `vision.logo_match` detail carries the reference store key and hash it was judged against.
2. Give consumers a validated reader for that detail. Done when: the schema pair accepts valid compared and not-compared details, refuses incomplete or malformed pairs, and reads a historical compared item as historical.
3. Prove it at the step. Done when: a case read back from storage names the exact reference key and hash its logo crop was compared with, across an index generation advance.

- [x] Extend `logoMatchItem` in `src/vision/logo-compare.ts` to take the compared reference (`key` and `sha256` from `ReferenceLogo` in `src/vision/logo-reference.ts`) and write `reference_key` and `reference_sha256` into the evidence `detail`. Done when: `test/vision/logo-compare.test.ts` asserts both fields on a same-brand and a different-brand item. Cheaper substitute: the reference slug alone, refused because two generations can share a slug while the key and hash name the exact stored object.
- [x] Pass the loaded reference through in `src/vision/step.ts` where `logoMatchItem` is called after `compareLogo`, so the recorded key is the object actually compared. Done when: `test/vision/step-read.test.ts` reads back a `vision.logo_match` item whose `reference_key` and `reference_sha256` are the seeded reference's key and digest, the stubbed comparison request's second image decodes to the seeded reference bytes, advancing the index to a new generation leaves the stored item naming the compared generation, and a replay then records the new generation's key and digest. Cheaper substitute: recording the brand name only, refused because it cannot identify which stored reference was drawn.
- [x] Add the validated consumer contract in `src/vision/logo-compare.ts`: `logoMatchDetailSchema` (compared items require `reference_key` and a 64-hex `reference_sha256`; not-compared items forbid both) and a reader that returns a historical compared item (checked, no pair) as historical with no identity, and refuses an incomplete or malformed pair. Done when: `test/vision/logo-compare.test.ts` covers a valid compared pair, a valid not-compared item, a stray reference field on a not-compared item, an incomplete pair, a malformed hash, and a historical compared item. Cheaper substitute: documenting the field names, refused because `StoredEvidence` accepts arbitrary JSON detail and an unvalidated reader would half-accept a wrong pair.
- [x] Keep un-compared items honest: `logoNotComparedItem` in `src/vision/logo-compare.ts` gains no `reference_key`, because `checked: false` means no comparison happened. Done when: `test/vision/logo-compare.test.ts` asserts the field's absence on a not-compared item.
- [x] Commit: `vision: record compared reference in logo match detail`

**Test checkpoint:** `pnpm exec vitest run test/vision/logo-compare.test.ts test/vision/step-read.test.ts` passes, and fails if a compared item lacks the reference key it was judged against.

> **Verified:** 2026-11-03 | §7 | d320b61b01f493853cfa63402e2b1cf881017031
> **Review:** `docs/reviews/d03-t03-s7.json`

## Verification

- Logo crops and judgements appear as evidence; the detector choice is measured and recorded.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
