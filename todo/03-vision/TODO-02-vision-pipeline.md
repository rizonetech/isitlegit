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
| 1 | §1 | Email HTML rendering to a screenshot | D02 T07 §2, D02 T05 §1 | [x] |
| 2 | §2 | PDF page rasterisation | §1 | [x] |
| 3 | §3 | Muse Spark structured reading of renders and pages | §1, D03 T01 §6 | [x] |
| 4 | §4 | Claimed brand against its real domains | §3, D02 T03 §3 | [x] |
| 5 | §5 | Recipient-client render fidelity corpus | §1 | [ ] |
| 6 | §6 | Ablation flag in page screening | D03 T04 §1, D04 T01 §14 | [x] |

## 1. Email HTML rendering to a screenshot

> **Started:** 2026-11-01T09:58:11Z

> **Corrected 2026-11-01 (D02 T07 §2 and §3 now on main, checked against the tree):** (1) The page is contained the way the walkthrough driver and `expandLink` (`src/checks/expand.ts`) contain theirs: browser-wide `Fetch.enable`, every request answered by the Worker's own `fetch` after `allowedUrl` (`src/walkthrough/url-policy.ts`), so the browser makes no request of its own. Here only images are allowed from the network (`image/*` answers, at most 40 resources, 2 MiB each and 8 MiB in all, bounded in time); a script, style sheet, frame, font, media, form post or any other request is refused, `cid:` images are answered from the stored attachments and `data:` images are refused by the page's own policy (a content-security meta tag, as most mail clients do) and counted from the parsed page, and scripts are off (`Emulation.setScriptExecutionDisabled` and `page.setJavaScriptEnabled(false)`), downloads denied at the browser (`Browser.setDownloadBehavior`), and any popup or other target closed. (2) The HTML is the parsed summary's `html` (`readArtefact(store, caseId, parsedKey(caseId))`), its attachments' `contentId` map the `cid:` images, and a case with no HTML renders its `visible.txt` (`readVisible`) as a monospace page, so every case has an image. (3) `renderEmail(browser, store, caseId, deps)` in `src/vision/render.ts` returns the two stored `render` artefacts (`putArtefact`, kind `render`, name `desktop-1024.png` and `phone-390.png`) with their pixel size and whether the 6000 px cap cut the page; it throws nothing for a page problem (an unreadable image is a blank, a timed-out page is a `RenderError` result), and the Workflow's `vision` step that calls it comes with D03 T02 §3. (4) The tests pass a stub `fetch` and a fixed policy, as the walkthrough tests do (`test/walkthrough/lure.ts`); fixtures live in `test/fixtures/vision/` (the fictional Protea Bank phishing email with a remote logo and a `cid:` image, a text-only mail, and a hostile mail with a script, a form, a frame and a tracking pixel to a private address).

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) The page runs through the contained driver's machinery, not a second policy: `@cloudflare/puppeteer` 1.4.0 and `env.BROWSER` are already wired (`src/walkthrough/driver.ts`, `wrangler.jsonc`), and `allowedUrl` in `src/walkthrough/url-policy.ts` is the one URL policy, so remote images are fetched by the Worker's `fetch` after that policy, never by the browser. D02 T07 §2's interception is still the prerequisite and is not built yet; reuse whichever lands first and never fork the policy. (2) `render` is already a `DERIVED_KINDS` member and `putArtefact` is in `src/intake/store.ts`; the plain-text page reads `visible.txt` through `visibleKey()`. (3) No email fixture exists: `test/fixtures/vision/` is created here with the fictional Protea Bank phishing email, a text-only mail and a `cid:` image mail (NimbusMail and Protea Bank are fictional, `test/fixtures/brands/` holds only their logos). (4) Render output is artefacts only; it writes no evidence, so it needs no producer name. (5) The Workflow step that calls it is added in §3 (a `vision` step between `checks` and `verdict`).

The member saw a rendered email, not HTML source. Browser Run renders the email HTML with scripts disabled and remote images allowed inside the sandbox (spec 4.4), at a desktop and a phone width.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

> **Corrected 2026-11-01 (plan review, P1 findings 1 and 2, P2 findings 3 to 6):** (a) The test renders through the real Browser Run bootstrap and decodes the stored PNGs: distinct page content in order, 1600 px wide, aspect preserved, bytes and metadata read back, on a document of more than five pages so the cap is proven. (b) Bounds are enforced in the rasteriser: at most 8 MiB of PDF, 5 pages, 12 million canvas pixels a page, 90 seconds a document; the page, its worker and blob URLs are released on every exit, and the same browser renders the next document after a stalled one. (c) The result names what it did per document (total and rendered pages, completeness, the reason when partial), and §3 carries that into evidence. (d) Outcomes are typed (`PdfUnreadable` with kind encrypted, malformed, unavailable or operational): a damaged or encrypted PDF is the document's refusal; a missing attachment, a storage failure, a browser failure or a timeout is operational, never reported as a malformed document, and one bad attachment never stops its siblings. (e) Each image's name carries its source attachment and page, and a retry writes the same artefacts again without duplicates. (f) The `vision.pdf_unreadable` item is written beside the producer's existing items, never replacing them.
> **Corrected 2026-11-01 (round 13):** the checklist's "stalled render" reads "stalled stage": the deadline races every stage (setup, render, retrieval, storage), and the tests prove a write that never settles is cut and the same browser renders the next document.

**Build order:**

1. Write `renderEmail(browser, store, caseId, deps)` in `src/vision/render.ts`. Done when: the layout fixture produces two PNGs in R2 whose decoded pixels show its parts.
2. Prove the containment and the failure paths. Done when: `test/vision/render.test.ts` passes with the hostile fixture, the budget, missing-input and deadline cases.

- [x] Load the stored HTML (or the visible text on a monospace page, or a page saying the message holds no text) into a Browser Run page with scripts off (`Emulation.setScriptExecutionDisabled` and `setJavaScriptEnabled(false)`), every request answered by the Worker's fetch after `allowedUrl`, images only (at most 40, 2 MiB each, 8 MiB in all), `cid:` images from the stored attachments, downloads denied and any other target closed. Done when: `test/vision/render.test.ts` decodes the stored PNG pixels and finds the remote and `cid:` images, the layout bar, and no block from the script; the hostile fixture's script image, style sheet, frame, form and private-address pixel never reach the stub fetch and no extra target survives.
- [x] Capture full-page PNGs at 1024 and 390 px widths, the height taken from the browser's layout and capped at 6000 px with a `cut` flag, stored as `render` artefacts. Done when: the stored bytes read back equal the recorded `bytes` and `sha256`, the desktop bar decodes red and the phone bar green, a 9000 px page gives 6000 px and `cut` true, and a short page `cut` false.
- [x] Report what became of the images (`images`: loaded, refused, failed, skipped, and `complete`) so D03 T02 §3 reads a picture that lost images as a partial reading. Done when: the test covers a 404 remote image, a missing `cid:` part and an exhausted resource budget.
- [x] Define the failures: `input-missing` (the parsed summary or the visible text is not stored, distinct from an empty message, which renders), `storage` (a read or write failed), `timeout` (the render's deadline) and `browser`. Done when: the test separates all of them.
- [x] Finish inside a deadline and release everything on every exit: the page, the interception, the target listener and the session, the browser staying the caller's. Done when: a stalled image ends at its own bound, a render cut by a short deadline leaves the page count where it was, and the same browser renders the next message.
- [x] Bound image bytes before they are held and across every source: a streamed read that stops at the per-image bound, one byte budget reserved before a body is read and one resource count for remote and `cid:` images (a stored `cid:` part past the bound is never buffered), and `data:` images refused by the page's content policy and counted from the parsed page however the markup spells them. Done when: an endless body is cut after a few chunks and counted, concurrent bodies cannot together exceed the budget, five `cid:` images against a limit of three give three loaded and two skipped, and a `data:` image is not drawn.
- [x] Count an image as loaded only when it is whole (the structure of its format walked to the end: every PNG chunk and CRC, a real size, a closed SVG; a guard, not a decoder), and follow at most three redirects with the URL policy applied at every hop. Done when: truncated remote, `cid:` and `data:` images are `failed`, a public redirect loads, a private redirect and a loop are refused.
- [x] Report the message's own cut (a body part the parser truncated, parts it omitted, text cut here) in `source` and let it make `complete` false, and report `ms` for the first capture and for both. Done when: a fixture with a truncated part gives `source.parts` 1 and `complete` false.
- [x] Make the deadline cover the whole render (reads and writes included), abort pending fetches and refuse any step after it, closing a page or session that arrives late. Done when: a browser whose page arrives after the deadline leaves no page behind and the next render succeeds, a stalled browser close cannot hold the caller past a bounded clean-up; a failed second capture and a failed R2 write give `browser` and `storage` and the next render succeeds.
- [x] Commit: `vision: email rendering to screenshots`

**Test checkpoint:** `pnpm exec vitest run test/vision/render.test.ts` passes and fails if scripts run, a non-image request reaches the network, or the height cap is dropped.

> **Verified:** 2026-11-01 | §1 | c4ccdddd078b2e83dd635a14de3ae7063e1145e1
> **Review:** `docs/reviews/d03-t02-s1.json`

## 2. PDF page rasterisation

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) `pdfjs-dist` is not installed and 6.4.299 is unverified: confirm the version exists on the registry before pinning it exactly. (2) The section did not say how the library reaches the Browser Run page: bundle it as a Worker static asset or inline module served to the page by the Worker's own fetch (the URL policy blocks every other origin), and record the choice. (3) `page` is already in `DERIVED_KINDS`. (4) Fixtures: `test/fixtures/pdf-forensics/*.pdf` and `eval/frontier/make-invoices.ts` are the nearest; a 3-page synthetic invoice and a damaged PDF are generated into `test/fixtures/vision/`. (5) The typed error becomes an `info` evidence item `vision.pdf_unreadable` written through the `vision` producer added in §3.

> **Started:** 2026-11-01T17:00:34Z

> **Corrected 2026-11-01 (at start):** `pdfjs-dist@6.4.299` is confirmed on the registry and pinned exactly. The library reaches the Browser Run page as a Worker text module (a `Text` rule in `wrangler.jsonc` for `pdf.min.mjs`) injected with `addScriptTag`, its worker taken from the same text as a blob URL in the page: no origin but the page itself is contacted, so the URL policy is untouched. The `vision` producer joins `LATER_PRODUCERS` here (the D02 T01 §5 seam), ahead of §3 which writes through it.

PDF attachments become page images for SAM and for the report's evidence cards; Muse Spark also reads PDFs natively (spec 4.4, 4.5). `pdfjs-dist` runs inside the Browser Run page.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Pin `pdfjs-dist` 6.4.299 in `package.json` and deliver it to the page as a Worker text module (`wrangler.jsonc`). Done when: the Worker bundles and the page holds the library without contacting an origin.
2. Rasterise the first 5 pages of each PDF attachment in `src/vision/pdf-pages.ts` inside the bounds below. Done when: a 3-page synthetic invoice yields 3 PNGs.
3. State a refused or partial document as typed evidence (`vision.pdf_unreadable`) and keep its siblings rendering. Done when: the checkpoint's mixed case reads back both.

- [x] Load `pdfjs-dist` 6.4.299 in the page and render the first 5 pages at 1600 px width to PNG `page` artefacts, inside the bounds above. Done when: `test/vision/pdf-pages.test.ts` decodes three distinct pages in order at 1600 px from a longer synthetic invoice, read back from the store.
- [x] Refuse encrypted or malformed PDFs with a typed error that becomes an info evidence item, beside any existing `vision` items. Done when: damaged and encrypted fixtures yield `vision.pdf_unreadable`, a stalled stage times out and the same browser renders the next document, and a mixed case renders its good PDF.
- [x] Commit: `vision: PDF page rasterisation`

**Test checkpoint:** `pnpm exec vitest run test/vision/pdf-pages.test.ts` passes.

> **Unstamped:** 2026-11-01: Stamped at 08aef233 before the coordinator's 2026-11-01 23:35 re-thought change and its one regular round (Round 4) were built; reopened so the section stamps once on the re-thought tip with the full round record (revoked receipt `docs/reviews/d03-t02-s2.revoked-2026-11-01.json`)

> **Verified:** 2026-11-01 | §2 | bb5e1ea9780b3a73d08e3a7fbc1172f339fbc75b
> **Review:** `docs/reviews/d03-t02-s2.json`

## 3. Muse Spark structured reading of renders and pages

> **Started:** 2026-11-01T22:22:46Z

> **Corrected 2026-11-01 (plan validation against the tree):** (1) The `vision` producer already stands in `LATER_PRODUCERS` (`src/checks/registry.ts:14` is `["walkthrough", "agent", "vision"]`), added by §2 ahead of this section, and `test/checks/evidence-producers.test.ts` already accepts a `vision.` item (8 passed, 2026-11-01): the registry checklist item below is ticked as shipped, and its Done when is the test. (2) `StepName` has since gained `transcribe`, `voice` and `walkthrough`; the `vision` step runs after `walkthrough` and before `verdict`, inside its own one-attempt budget like the voice step, and never throws for a content or model problem: it states `vision.not_checked` (info, `detail.checked: false`) and the case goes on. (3) The reading's images are the desktop render plus the PDF page images §2 stored, at most 6 images in all; completeness rides in the items' `detail` (`render.complete`, each PDF's `complete`), and a picture that lost content is a partial reading, as §1's `RenderResult` already states. (4) Every write through `addEvidence` replaces the producer's set, so the step gathers its items (PDF failures through §2's `recordPdfFailure` wording, reading items, or the not-checked item) and carries the ones already there, the pattern `recordPdfFailure` itself uses. (5) The cache is `withCache` over the `CACHE` KV (D03 T01 §4): artefacts are the render's and pages' SHA-256, params carry the visible text's SHA-256 and the prompt version, and a hit writes the same evidence with no model call.

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) Evidence from this file is written with `addEvidence(db, caseId, "vision", items)` (D02 T01 §5): `LATER_PRODUCERS` in `src/checks/registry.ts:14` is `["walkthrough"]` and `addEvidence` refuses any other family, so this section adds `"vision"` to that one constant (a one-line change in the checks lane's file, the same kind of change D02 T01 §5 approved; tell the coordinator in the stamp message). The items are `vision.claimed_brand`, `vision.requested_action`, `vision.urgency`, and from §2 and §4 `vision.pdf_unreadable` and `vision.brand_domain_mismatch`; every one stays inside the `vision.` family. (2) The Workflow has no render or vision step (`StepName` in `src/pipeline/analysis-workflow.ts:60` is admit, parse, checks, verdict, store, reply, finish): add a `vision` step between `checks` and `verdict` that renders, reads and records, bounded and failing soft to a `not_checked`-style info item so a model outage never fails a case. (3) `structured()` (`src/meta/structured.ts`), `untrusted()` (`src/meta/untrusted.ts`) and the cache (`src/meta/cache.ts`, whose inputs already count artefacts) exist; the image goes in as an `input_image` data URL and costs the `IMAGE_TOKEN_BOUND` of 6000 in `src/meta/pricing.ts`. (4) Results go in `docs/frontier-log.md` after the shared Meta day cap allows live runs.

Muse Spark reads the rendered email (and PDF pages) as images plus the visible text in an untrusted block, and returns a structured view: claimed brand, requested action (log in, pay, open file, call, reply with details, none), urgency cues with quotes, visible sender identity (spec 4.4).

**Phase:** 3
**Needs:** meta-api
**Surface:** no

> **Corrected 2026-11-01 (plan review, P1 findings 1 to 4, P2 findings 5 and 6):** (1) Readings are per image: the call names its images `image-1` to `image-N` in a manifest (the desktop render first, then PDF pages in attachment and page order, at most 6), the schema is built with those identifiers as the `image` enum, and every reading names its image, so an email and an invoice claiming different brands yield separate items whose `detail` carries the source artefact key and name. (2) The step orchestrates the PDFs itself: it discovers the case's PDF attachments, calls `rasterisePdf` for each on the shared browser, keeps successful siblings, and records each failure through `recordPdfFailure` before reading. (3) Coverage is evidence, not a nested flag: when the picture is incomplete (the render lost content, a PDF is partial, or images past the 6-image cap were omitted), the step also writes `vision.coverage` (info, `detail.checked: false`, the losses and the omitted count named), which is what the verdict's partial rule reads; selection is deterministic (render first, then pages in order). (4) The Workflow test asserts the step ran after `walkthrough`, that vision evidence (including a persisted `vision.not_checked` with `checked: false` on a stubbed model failure, and PDF failures preserved through the reading write) stands before `verdict` starts, and that a stalled render or model still ends the step inside its budget. (5) The cache keeps the validated reading only, never a partial-coverage one (`withCache` partial), and the evidence is rebuilt for the current case from it; the key covers every artefact SHA, the visible text's SHA and the prompt and schema versions, and a changed text, image or version misses. (6) The schema bounds its fields (`claimed_brand` at most 120 characters, at most 8 urgency cues of at most 200 characters, `confidence` within 0 to 1); absent values write no item (a null brand with no visible sender, an action of none, no cues), and the severity map is fixed: `vision.requested_action` is high for log in or pay with urgency cues, medium for log in, pay, open file or reply with details without them, info for call; `vision.urgency` is medium; `vision.claimed_brand` is info with the visible sender in its summary and detail.

**Build order:**

1. Define the schema and the call. Done when: a stubbed test turns a model reply into evidence items.
2. Run it live on three fixtures. Done when: results, latency and cost are recorded in `docs/frontier-log.md`.

- [x] Define `MailReading` in `src/vision/reading-schema.ts`: per-image readings (`image` identifier, `claimed_brand` nullable and bounded, `requested_action` enum, `urgency_cues` bounded quotes, `visible_sender`, `payment_request` boolean, `confidence` within 0 to 1). Done when: `z.toJSONSchema` output is non-recursive and the schema refuses an out-of-range confidence and an identifier that was not sent.
- [x] Call `muse-spark-1.3` through `structured()` with the desktop render and PDF page images as `input_image` (base64 data URLs, named in a manifest) and `visible.txt` inside `untrusted("email")`. Done when: `test/vision/reading.test.ts` checks the request has the images, the untrusted block and `store: false`, and a stub reply with conflicting brands across images yields separate items.
- [x] Add `"vision"` to `LATER_PRODUCERS` in `src/checks/registry.ts` and write the items with `addEvidence(db, caseId, "vision", items)`. Done when: `test/checks/evidence-producers.test.ts` accepts a `vision.` item and still refuses an unknown family. Shipped by §2 (`src/checks/registry.ts:14`); the test passes (8 passed, 2026-11-01).
- [x] Add a `vision` step between `walkthrough` and `verdict` in `src/pipeline/analysis-workflow.ts` that discovers the PDF attachments, rasterises each (failures recorded, siblings kept), renders, reads and records, and fails soft to `vision.not_checked`. Done when: `test/pipeline/analysis-workflow.test.ts` runs a case with a valid and an unreadable PDF and a stubbed model failure to a verdict, with the step's order, the persisted items and the bounded stall asserted.
- [x] Turn each reading into evidence `vision.claimed_brand`, `vision.requested_action` (the severity map in the plan-review correction above) and `vision.urgency`, each naming its source artefact, plus `vision.coverage` when the picture is incomplete. Done when: the stub replies (malformed output, a refusal, a null brand, no action, no urgency, urgent and non-urgent pay and log in) yield the mapped items and no invented ones.
- [x] Cache the validated reading by artefact SHA-256, visible-text SHA and prompt version (D03 T01 §4), never a partial-coverage reading, and rebuild the evidence per case on a hit. Done when: a second identical case makes no model call and reads its evidence back, and a changed text, image or prompt version misses.
- [x] Run it on three synthetic fixtures after the credit gate and record results in `docs/frontier-log.md`. Done when: the entry exists.
- [x] Commit: `vision: Muse Spark structured reading`

**Test checkpoint:** `pnpm exec vitest run test/vision/reading.test.ts test/pipeline/analysis-workflow.test.ts` passes and fails if the visible text is sent outside the untrusted block.

> **Verified:** 2026-11-02 | §3 | 7f5be217c1e4bf03e850bb8f764bfb4a78d715a6
> **Review:** `docs/reviews/d03-t02-s3.json`

## 4. Claimed brand against its real domains

> **Started:** 2026-11-02T04:57:21Z

> **Corrected 2026-11-02 (walkthrough lane, plan validation against the tree):** (1) The table is loaded, not static: `brandTable(env)` in `src/checks/brands.ts` reads KV with the bundled fallback, and `getBrand(table, name)` takes the loaded table; the vision step supplies `{ CACHE: deps.kv }`. (2) The domains this section checks are the ones the vision step holds: the sender domain shown on the picture (parsed from the reading's `visible_sender`); the §3 reading schema carries no landing domain, so the check function accepts landing domains from any caller that has them and the step passes the sender domain today. (3) The guard lift is a context marker, not a caller check: `MetaContext` gains `search: { maxSearches }`, present only on the grounded brand call, and any `web_search*` tool without it still refuses in both Responses calls; pricing gains searches (`Usage.searches`, the estimate's `Bound.searches`) at US$0.0025 a search, settled from the response's own `web_search_call` count, with the per-case cap the marker carries. (4) The grounded answer is parsed from the raw response (its `url_citation` annotations are the citations), zod-validated, and cached in the CACHE KV under the normalised brand name and a prompt version for 30 days. (5) The brand items are computed in the vision step after the reading and join its items before the commit, written through `writeVision` like every vision item.

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) `brand.domain_mismatch` is named nowhere else in the tree, so it is renamed `vision.brand_domain_mismatch` and written through the `vision` producer (a normal check cannot run: it needs the model's claimed brand from §3). `getBrand` and `brandForDomain` exist in `src/checks/brands.ts`; `data/brands.json` holds 23 brands. (2) Search grounding is blocked in the client: `src/meta/client.ts:127` throws a `ModelError` for any `web_search*` tool ("not budgeted yet"). This section lifts that guard only for the grounded brand call, under the shared ledger (`localBudget`, US$2.50 per 1,000 searches plus tokens from `pricing-rate-limits.md`) and a per-case cap, with a test that any other caller still refuses. (3) The 30 day cache key is the normalised brand name and the prompt version. (4) The cited URL must be on the claimed brand's own site, checked by `registrable()`; an uncited or off-site citation yields "could not be confirmed".

> **Corrected 2026-11-02 (plan review, P2 findings 1 to 8, planned into this section):** (1) Inputs: the compared domains are, per claimed brand, the case's authoritative sender domain (the parsed summary's From through `originalHeaderOf` in `src/intake/original-header.ts`), the landing and link hosts the checks evidence already carries (every `http(s)` address in the case's evidence `detail`, read before the vision commit), and the domain shown in that reading's `visible_sender`; each domain keeps its kind (`sender`, `landing`, `shown`) in the item's `detail`, and a branded picture with no displayed address still compares the sender and landing domains. (2) Grounded acceptance is per domain and never circular: a proposed domain is accepted only when a `url_citation` whose own registrable domain is that domain names the claimed brand in its title or cited span, and no citation on a domain under comparison in this case (sender, landing or shown) can establish that domain (a domain under judgement is not its own witness); unsupported proposed domains are dropped, and when none is accepted the brand is unconfirmed, never matched or mismatched from the model's word alone. (3) Cap: Meta documents no per-request search-count parameter, so the cap is enforced at reservation and acceptance: `MetaContext.search` carries `maxSearches`, the reservation prices that many searches, the settlement counts the response's own `web_search_call` items at US$0.0025 each, an answer that searched more than `maxSearches` is rejected as unconfirmed, and the vision step grounds at most 2 unknown brands a case (further brands are unconfirmed with reason `search-cap`), one call a brand, no repair call. (4) Isolation: the brand stage runs per brand inside its own try, after the reading items exist; a refusal, malformed answer, outage, budget refusal or missing comparison domain yields that brand's unconfirmed item and never discards reading, PDF or sibling brand items. (5) Deadline: the grounded call and its cache work inherit the step's remaining deadline and expiry predicate (`deadlineMs`, `expired` on the Meta context, re-read before the cache write); a late answer publishes no cache entry and starts no further paid work, while the reading already gained stands. (6) Replay: `vision.brand_domain_mismatch` (which also carries the unconfirmed outcomes, `detail.confirmed: false`, severity info) joins `ATTEMPT_OWNED` in `src/vision/step.ts`, so a replay replaces the last attempt's brand outcomes; step tests read the stored evidence back for mismatch, mismatch-to-match and unconfirmed-to-confirmed transitions, keeping PDF items. (7) Comparison: table brands are matched through `brandForDomain` (official only, so `user_content` hosts and community labels never clear a sender), grounded brands by registrable domain against the accepted domains; hosts are normalised (case, trailing dot, subdomain to registrable) before comparison, and the tests cover a legitimate domain and subdomain, a lookalike suffix host, and a hosted user-content host. (8) Prompt and cache: the claimed brand (hostile text) reaches the grounded prompt only inside an `untrusted` block, the answer is zod-validated before use and again on every cache read, only an accepted (confirmed) resolution is cached, a KV failure is a miss, an expired or malformed entry is a miss, and the prompt version is part of the key; a second case reuses only the domain resolution and computes its own comparison.

A claimed brand is checked against its real domains: the curated table first, then Muse Spark search grounding with citations for brands not in the table (spec 4.4). The finding names the source.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Record `vision.brand_domain_mismatch`. Done when: a fixture claiming a table brand from another domain yields it with the table as source.
2. Add search grounding for unknown brands. Done when: a stubbed grounded answer with a citation yields the item with the cited URL.

- [x] Look up the claimed brand with `getBrand` (D02 T03 §3) and record `vision.brand_domain_mismatch` (high when the sender or landing domain is not one of the brand's domains). Done when: `test/vision/brand.test.ts` passes for the fictional bank fixture.
- [x] Lift the `web_search*` refusal in `src/meta/client.ts` for the grounded brand call only, under the ledger and a per-case cap. Done when: `test/meta/client.test.ts` shows the grounded call allowed and any other caller still refused.
- [x] For a brand not in the table, call `muse-spark-1.3` with search grounding (`https://dev.meta.ai/docs/search-grounding`) asking for the brand's official domains, requiring at least one citation from the brand's own site, and cache the answer 30 days. Done when: a stubbed grounded reply produces the item with `detail.source_url`; a reply without a citation yields "could not be confirmed". Cheaper substitute: trusting the model's answer without a citation.
- [x] Count grounding calls against the budget at US$2.50 per 1,000 searches plus tokens. Done when: the spend row records it.
- [x] Compare the domains the case actually holds in `src/vision/brand.ts` (`sender` from the parsed From, `landing` from the checks evidence addresses, `shown` from the reading's `visible_sender`), matched for table brands through `brandForDomain` official-only and normalised to registrable domains. Done when: `test/vision/brand.test.ts` passes for a legitimate domain and subdomain (no item), a lookalike suffix host, a hosted user-content host, and a branded picture with no displayed address.
- [x] Accept a grounded domain only on its own site's citation naming the brand, never on a citation from a domain under comparison, in `src/vision/brand.ts`. Done when: the checkpoint test fails on an uncited answer, an off-site citation, an impersonator citing its own sending site, and an answer mixing one supported domain with an unsupported one (only the supported one is used).
- [x] Enforce the search cap at reservation and acceptance (`MetaContext.search.maxSearches`, settled from the response's `web_search_call` count in `src/meta/client.ts` and `src/meta/pricing.ts`; at most 2 unknown brands grounded a case in `src/vision/step.ts`). Done when: `test/meta/client.test.ts` and `test/vision/brand.test.ts` show an over-cap answer rejected as unconfirmed, a third unknown brand unconfirmed without a call, and the spend row's searches counted.
- [x] Isolate and fence the brand stage in `src/vision/step.ts`: per brand, after the reading, under the step's remaining deadline and expiry, with `vision.brand_domain_mismatch` attempt-owned so replays replace it. Done when: `test/vision/step-read.test.ts` reads back mismatch, mismatch-to-match and unconfirmed-to-confirmed transitions with PDF items kept, a grounded outage leaves the reading items standing, and a stalled lookup publishes no cache entry and starts no further paid work after expiry.
- [x] Cache only accepted resolutions 30 days in the CACHE KV from `src/vision/brand.ts`, keyed by the normalised brand name and `BRAND_PROMPT_VERSION`, zod-validated on read, the claimed brand sent only inside an `untrusted` block, KV failure a miss. Done when: `test/vision/brand.test.ts` covers a hit (no second call, the second case's own comparison), a malformed or expired entry, a prompt-version miss, and an injected brand string that stays inside the block.
- [x] Commit: `vision: claimed brand against its real domains`

**Test checkpoint:** `pnpm exec vitest run test/vision/brand.test.ts` passes and fails if an uncited grounded answer is accepted.

> **Verified:** 2026-11-02 | §4 | 6ffa8726892e7902771be81d20f91fb8c1c8958d
> **Review:** `docs/reviews/d03-t02-s4.json`

## 5. Recipient-client render

> **Filed 2026-11-01 from D03 T02 §1's completion review (out of scope there):** two Chromium widths do not reproduce Outlook, Gmail or Apple Mail, whose rendering rules differ (stripped styles, dark-mode rewrites, blocked images); a lure that depends on one of them can look different to the recipient.

A synthetic corpus of fictional-brand emails whose client-specific markup (Outlook conditional comments, Gmail style stripping, dark-mode colour inversion, blocked remote images) is rendered by the real clients on desktop and phone, stored as golden images; the renderer's output is compared with them and every material difference is either represented or disclosed to the member on the report. A design decision (whether to emulate client rules in the renderer or to disclose) is made first.

**Phase:** 7
**Needs:** attended
**Surface:** no

**Build order:**

1. Decide the approach. Done when: `docs/frontier-log.md` records emulate or disclose, with the reason.
2. Build the corpus and the comparison. Done when: `test/vision/fidelity.test.ts` lists each difference as represented or disclosed.

- [ ] Write the decision (emulate client rules in `src/vision/render.ts`, or disclose that the picture is a Chromium rendering) with the three clients' behaviours that matter for phishing (hidden or blocked images, stripped styles, dark-mode inversion). Done when: the frontier-log entry exists and names the chosen approach.
- [ ] Capture golden desktop and phone renders from Outlook, Gmail and Apple Mail for five fictional-brand fixtures under `test/fixtures/vision/clients/` (an attended step: the operator's accounts). Done when: the files exist with the client, device and date in their names.
- [ ] Compare the renderer's output with each golden render and record every material difference. Done when: `test/vision/fidelity.test.ts` fails on an unrecorded difference.
- [ ] Commit: `vision: recipient-client render fidelity corpus`

**Test checkpoint:** `pnpm exec vitest run test/vision/fidelity.test.ts` passes and fails on an unrecorded difference.

## 6. Ablation flag in page screening

> **Started:** 2026-11-03T20:52:00Z

> **Corrected 2026-11-03 (plan validation against the tree):** (1) `openGlimmer` (`src/vision/screen.ts`) takes an optional `ablateFlag?: () => Promise<AblateFlag | null>` on `WakeCtx` (wired in `monitorDeps` in `src/monitor/workflow.ts` through `ablateFlagFor(env.CACHE, orgId)` from `src/pipeline/ablate.ts` over the run's organisation); when it returns `"no-screening"` (a rejected reader treated as null so a KV failure never stops Loupe), `openGlimmer` returns an ablated session (`burst: null`, `state: { down: "ablated" }`, `reservedUntil: 0`, `lastRequestEnd: null`) without calling `wakeGlimmer`, so no Fireworks request or runtime minutes reservation is made. (2) `screenPage` checks whether `session.state` is `{ down: "ablated" }` (or an optional `ablateFlag` reader on `Page` / `GlimmerSession` returns `"no-screening"`): Loupe is never asked, `glimmer_reason` is `"ablated"`, Muse Spark screens the page (keeping its confidence-escalation pass when unsure), and a successful `Screened` result carries `ablated: "no-screening"` (absent/null when unflagged) alongside `glimmer_reason: "ablated"`. (3) In `src/monitor/screen.ts`, `monitor_screens.glimmer_reason` already stores `result.glimmer_reason` (`"ablated"`), so the persisted screening record in D1 states the ablation without a schema migration.

> **Corrected 2026-11-03 (plan review, gaps 1 to 2, planned in):** (1) `MonitorDeps.open` (`src/monitor/run.ts`) passes `orgId` (`deps.open(calls, orgId)`) so `monitorDeps` (`src/monitor/workflow.ts`) reads `ablateFlagFor(env.CACHE, orgId ?? null)` for the run's actual organisation; `test/vision/screen.test.ts` exercises the real `monitorDeps` + `monitorOrg` entry point with `ablate:<orgId>` in KV, reads the resulting D1 `monitor_screens` row (`screener: "spark"`, `glimmer_reason: "ablated"`), proves organisation isolation (an unflagged second organisation still uses Loupe), and proves that clearing `ablate:<orgId>` restores Loupe on the next run. (2) `test/vision/screen.test.ts` covers the ablated Spark failure and escalation paths: budget refusal, provider failure (HTTP 500), and invalid output stay failed (`ok: false`, `glimmer_reason: "ablated"`) with no successful screening row or Loupe fallback in `monitorOrg`, and an unsure first Spark answer takes the second Spark pass while retaining `ablated: "no-screening"`, `glimmer_reason: "ablated"`, `tier: "spark-second"`, `escalation: "spark-unsure"`, `spark_calls` references, and the two-call ceiling.

Filed 2026-11-02 from the coordinator's assignment for eval D08 T02 §3, on the shared reader of D04 T01 §14: for a `no-screening` case, Loupe never screens a page and Muse Spark screens every page instead (eval's contract in `eval/ablate.ts`), with the screening findings marked ablated so the arm measures Spark's unaided screening.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Read the flag where the screener chooses Loupe or Spark. Done when: a flagged page never reaches the Loupe endpoint.
2. Mark the findings of the Spark-only path. Done when: the stored screening states the ablation.

- [x] Honour `no-screening` in `openGlimmer` and `screenPage` (`src/vision/screen.ts`, wired in `src/monitor/workflow.ts` and `src/monitor/run.ts` by passing `orgId` into `deps.open(calls, orgId)`) through `ablateFlagFor` (D04 T01 §14): the Loupe session is never opened for a flagged organisation (no Fireworks wake or runtime ledger reservation), Muse Spark screens every page, the returned `Screened` states `ablated: "no-screening"` and `glimmer_reason: "ablated"`, and the persisted `monitor_screens` row records `glimmer_reason: "ablated"`. Done when: `test/vision/screen.test.ts` shows (a) a flagged organisation/page with no Loupe request in its fetch log and no `glimmer_runtime` row, a Spark screening returned with `ablated: "no-screening"` and `glimmer_reason: "ablated"`, (b) through `monitorDeps` + `monitorOrg` with `ablate:<orgId>` in KV, the D1 `monitor_screens` row records `screener: "spark"` and `glimmer_reason: "ablated"`, an unflagged second organisation is isolated on Loupe, and clearing the flag restores Loupe on the next run, (c) under `no-screening`, budget refusal, provider 500 and invalid output stay `ok: false` with `glimmer_reason: "ablated"` (and in `monitorOrg` leave the run partial with no screening row or Loupe fallback), and an unsure first Spark answer escalates to the second pass retaining `ablated: "no-screening"`, `spark_calls` and the two-call ceiling, and (d) an unflagged, other-flag or failed-reader organisation screens on Loupe as today.
- [x] Commit: `vision: ablation flag in page screening`

**Test checkpoint:** `pnpm exec vitest run test/vision/screen.test.ts` passes, and fails if a flagged page is sent to Loupe.

> **Verified:** 2026-11-03 | §6 | c40f1017b20e9abc4e9f9b6386f3bb67cc44cd86
> **Review:** `docs/reviews/d03-t02-s6.json`

## Verification

- Rendered screenshots, page images and Spark readings appear as evidence with artefacts; brand mismatches cite their source.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
