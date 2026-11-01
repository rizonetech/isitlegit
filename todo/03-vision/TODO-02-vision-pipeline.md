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

> **Started:** 2026-11-01T09:58:11Z

> **Corrected 2026-11-01 (D02 T07 §2 and §3 now on main, checked against the tree):** (1) The page is contained the way the walkthrough driver and `expandLink` (`src/checks/expand.ts`) contain theirs: browser-wide `Fetch.enable`, every request answered by the Worker's own `fetch` after `allowedUrl` (`src/walkthrough/url-policy.ts`), so the browser makes no request of its own. Here only images are allowed from the network (`image/*` answers, at most 40 resources, 2 MiB each and 8 MiB in all, bounded in time); a script, style sheet, frame, font, media, form post or any other request is refused, `cid:` and `data:` images are answered from the stored attachments and the message itself, and scripts are off (`Emulation.setScriptExecutionDisabled` and `page.setJavaScriptEnabled(false)`), downloads denied at the browser (`Browser.setDownloadBehavior`), and any popup or other target closed. (2) The HTML is the parsed summary's `html` (`readArtefact(store, caseId, parsedKey(caseId))`), its attachments' `contentId` map the `cid:` images, and a case with no HTML renders its `visible.txt` (`readVisible`) as a monospace page, so every case has an image. (3) `renderEmail(browser, store, caseId, deps)` in `src/vision/render.ts` returns the two stored `render` artefacts (`putArtefact`, kind `render`, name `desktop-1024.png` and `phone-390.png`) with their pixel size and whether the 6000 px cap cut the page; it throws nothing for a page problem (an unreadable image is a blank, a timed-out page is a `RenderError` result), and the Workflow's `vision` step that calls it comes with D03 T02 §3. (4) The tests pass a stub `fetch` and a fixed policy, as the walkthrough tests do (`test/walkthrough/lure.ts`); fixtures live in `test/fixtures/vision/` (the fictional Protea Bank phishing email with a remote logo and a `cid:` image, a text-only mail, and a hostile mail with a script, a form, a frame and a tracking pixel to a private address).

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) The page runs through the contained driver's machinery, not a second policy: `@cloudflare/puppeteer` 1.4.0 and `env.BROWSER` are already wired (`src/walkthrough/driver.ts`, `wrangler.jsonc`), and `allowedUrl` in `src/walkthrough/url-policy.ts` is the one URL policy, so remote images are fetched by the Worker's `fetch` after that policy, never by the browser. D02 T07 §2's interception is still the prerequisite and is not built yet; reuse whichever lands first and never fork the policy. (2) `render` is already a `DERIVED_KINDS` member and `putArtefact` is in `src/intake/store.ts`; the plain-text page reads `visible.txt` through `visibleKey()`. (3) No email fixture exists: `test/fixtures/vision/` is created here with the fictional Protea Bank phishing email, a text-only mail and a `cid:` image mail (NimbusMail and Protea Bank are fictional, `test/fixtures/brands/` holds only their logos). (4) Render output is artefacts only; it writes no evidence, so it needs no producer name. (5) The Workflow step that calls it is added in §3 (a `vision` step between `checks` and `verdict`).

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

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) `pdfjs-dist` is not installed and 6.4.299 is unverified: confirm the version exists on the registry before pinning it exactly. (2) The section did not say how the library reaches the Browser Run page: bundle it as a Worker static asset or inline module served to the page by the Worker's own fetch (the URL policy blocks every other origin), and record the choice. (3) `page` is already in `DERIVED_KINDS`. (4) Fixtures: `test/fixtures/pdf-forensics/*.pdf` and `eval/frontier/make-invoices.ts` are the nearest; a 3-page synthetic invoice and a damaged PDF are generated into `test/fixtures/vision/`. (5) The typed error becomes an `info` evidence item `vision.pdf_unreadable` written through the `vision` producer added in §3.

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

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) Evidence from this file is written with `addEvidence(db, caseId, "vision", items)` (D02 T01 §5): `LATER_PRODUCERS` in `src/checks/registry.ts:14` is `["walkthrough"]` and `addEvidence` refuses any other family, so this section adds `"vision"` to that one constant (a one-line change in the checks lane's file, the same kind of change D02 T01 §5 approved; tell the coordinator in the stamp message). The items are `vision.claimed_brand`, `vision.requested_action`, `vision.urgency`, and from §2 and §4 `vision.pdf_unreadable` and `vision.brand_domain_mismatch`; every one stays inside the `vision.` family. (2) The Workflow has no render or vision step (`StepName` in `src/pipeline/analysis-workflow.ts:60` is admit, parse, checks, verdict, store, reply, finish): add a `vision` step between `checks` and `verdict` that renders, reads and records, bounded and failing soft to a `not_checked`-style info item so a model outage never fails a case. (3) `structured()` (`src/meta/structured.ts`), `untrusted()` (`src/meta/untrusted.ts`) and the cache (`src/meta/cache.ts`, whose inputs already count artefacts) exist; the image goes in as an `input_image` data URL and costs the `IMAGE_TOKEN_BOUND` of 6000 in `src/meta/pricing.ts`. (4) Results go in `docs/frontier-log.md` after the shared Meta day cap allows live runs.

Muse Spark reads the rendered email (and PDF pages) as images plus the visible text in an untrusted block, and returns a structured view: claimed brand, requested action (log in, pay, open file, call, reply with details, none), urgency cues with quotes, visible sender identity (spec 4.4).

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Define the schema and the call. Done when: a stubbed test turns a model reply into evidence items.
2. Run it live on three fixtures. Done when: results, latency and cost are recorded in `docs/frontier-log.md`.

- [ ] Define `MailReading` in `src/vision/reading-schema.ts` (`claimed_brand` nullable, `requested_action` enum, `urgency_cues` array of short quotes, `visible_sender`, `payment_request` boolean, `confidence`). Done when: `z.toJSONSchema` output is non-recursive.
- [ ] Call `muse-spark-1.3` through `structured()` with the desktop render as `input_image` (base64 data URL) and `visible.txt` inside `untrusted("email")`. Done when: `test/vision/reading.test.ts` checks the request has the image, the untrusted block and `store: false`.
- [ ] Add `"vision"` to `LATER_PRODUCERS` in `src/checks/registry.ts` and write the items with `addEvidence(db, caseId, "vision", items)`. Done when: `test/checks/evidence-producers.test.ts` accepts a `vision.` item and still refuses an unknown family.
- [ ] Add a `vision` step between `checks` and `verdict` in `src/pipeline/analysis-workflow.ts` that renders, reads and records, and fails soft to an info item. Done when: `test/pipeline/analysis-workflow.test.ts` runs a case with a stubbed model failure to a verdict.
- [ ] Turn the reading into evidence `vision.claimed_brand`, `vision.requested_action` (high for log in or pay with urgency), `vision.urgency`. Done when: the stub reply yields the three items.
- [ ] Cache by render SHA-256 and prompt version (D03 T01 §4). Done when: a second identical case makes no model call.
- [ ] Run it on three synthetic fixtures after the credit gate and record results in `docs/frontier-log.md`. Done when: the entry exists.
- [ ] Commit: `vision: Muse Spark structured reading`

**Test checkpoint:** `pnpm exec vitest run test/vision/reading.test.ts` passes and fails if the visible text is sent outside the untrusted block.

## 4. Claimed brand against its real domains

> **Corrected 2026-11-01 (taken over by the walkthrough lane, checked against the tree):** (1) `brand.domain_mismatch` is named nowhere else in the tree, so it is renamed `vision.brand_domain_mismatch` and written through the `vision` producer (a normal check cannot run: it needs the model's claimed brand from §3). `getBrand` and `brandForDomain` exist in `src/checks/brands.ts`; `data/brands.json` holds 23 brands. (2) Search grounding is blocked in the client: `src/meta/client.ts:127` throws a `ModelError` for any `web_search*` tool ("not budgeted yet"). This section lifts that guard only for the grounded brand call, under the shared ledger (`localBudget`, US$2.50 per 1,000 searches plus tokens from `pricing-rate-limits.md`) and a per-case cap, with a test that any other caller still refuses. (3) The 30 day cache key is the normalised brand name and the prompt version. (4) The cited URL must be on the claimed brand's own site, checked by `registrable()`; an uncited or off-site citation yields "could not be confirmed".

A claimed brand is checked against its real domains: the curated table first, then Muse Spark search grounding with citations for brands not in the table (spec 4.4). The finding names the source.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Record `vision.brand_domain_mismatch`. Done when: a fixture claiming a table brand from another domain yields it with the table as source.
2. Add search grounding for unknown brands. Done when: a stubbed grounded answer with a citation yields the item with the cited URL.

- [ ] Look up the claimed brand with `getBrand` (D02 T03 §3) and record `vision.brand_domain_mismatch` (high when the sender or landing domain is not one of the brand's domains). Done when: `test/vision/brand.test.ts` passes for the fictional bank fixture.
- [ ] Lift the `web_search*` refusal in `src/meta/client.ts` for the grounded brand call only, under the ledger and a per-case cap. Done when: `test/meta/client.test.ts` shows the grounded call allowed and any other caller still refused.
- [ ] For a brand not in the table, call `muse-spark-1.3` with search grounding (`https://dev.meta.ai/docs/search-grounding`) asking for the brand's official domains, requiring at least one citation from the brand's own site, and cache the answer 30 days. Done when: a stubbed grounded reply produces the item with `detail.source_url`; a reply without a citation yields "could not be confirmed". Cheaper substitute: trusting the model's answer without a citation.
- [ ] Count grounding calls against the budget at US$2.50 per 1,000 searches plus tokens. Done when: the spend row records it.
- [ ] Commit: `vision: claimed brand against its real domains`

**Test checkpoint:** `pnpm exec vitest run test/vision/brand.test.ts` passes and fails if an uncited grounded answer is accepted.

## Verification

- Rendered screenshots, page images and Spark readings appear as evidence with artefacts; brand mismatches cite their source.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
