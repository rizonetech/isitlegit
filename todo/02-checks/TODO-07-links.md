---
schema_version: 1
id: links
domain: 02-checks
status: active
title: "TODO-07 -- Links, Redirects, Landing Pages and QR Codes"
track: day-3
---

# TODO-07 -- Links, Redirects, Landing Pages and QR Codes

> **Goal:** Every link in the mail (HTML, text, PDF annotations, HTML attachments, QR codes in images and PDF pages) is extracted, its redirects are followed in an isolated Browser Run session with downloads blocked, and the landing page is screenshotted and checked for password and card forms; each step is evidence with the final URL, domain and screenshot.

> **Current state:** Measured 2026-10-26 20:00 SAST. The `BROWSER` binding exists (D00 T01 §5); no link code exists.

## Inputs

- Design spec 4.3 (Links, QR codes), 4.4a (the walkthrough runs only when this finds a form or lure button), 8 (cut list: QR decoding first, landing screenshots for links without a form second).
- Stack doc: `@cloudflare/puppeteer` 1.4.0, `jsqr` 1.4.0 and `pdfjs-dist` 6.4.299 inside the Browser Run page.
- -> XREF: D01 T01 §5 -- the parsed summary's `truncated` parts, whose full text and HTML the extraction still reads
- -> XREF: D04 T02 §6 -- the walkthrough trigger that reads this file's form findings

## Outcome

- A synthetic mail linking through two redirects to a fictional-brand login page on `fixtures.isitlegit.co.za` yields the redirect chain, the final domain, a screenshot and a "password form" item.
- No file is ever downloaded or executed; a page that tries is recorded and stopped.

**Adjacency:** all=not-applicable (pure evidence producers; shown on the report, D07 T03 §3)

**Adjacency rationale:** These checks only add evidence and artefacts to a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | URL extraction from text, HTML and PDF annotations | D02 T01 §2 | [ ] |
| 2 | §2 | Redirect expansion in Browser Run | §1, D00 T01 §5 | [ ] |
| 3 | §3 | Landing screenshot and form detection | §2 | [ ] |
| 4 | §4 | QR code decoding from images and PDF pages | §2 | [ ] |

## 1. URL extraction from text, HTML and PDF annotations

All URLs are collected with where they came from, so the report can say "the button labelled View invoice goes to ...". Visible link text that names a different domain than its target is itself evidence.

> **Started:** 2026-10-31T11:20Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) checks are pure (D02 T01 §1), so the links are read by the Workflow's `checks` step (`linksOf` in `src/checks/links.ts`, called from `checks()` in `src/pipeline/analysis-workflow.ts`) into a new `CaseView.links` (`{ items, more, unread }`, null when the case has no body or file to read), and `link.text_mismatch` reads only the view; §2 and §3 read the same list; (2) HTML is read with `HTMLRewriter` as it streams, as `hiddenTextOf` reads it: `a` and `area` `href`, `form` `action`, `button` and `input` `formaction`, `iframe` and `frame` `src`, `img` `src` and `srcset`, and `meta http-equiv=refresh`'s URL; only absolute `http:` and `https:` URLs are links (a scheme-relative `//host` is read as `https:`; `mailto:`, `tel:`, `javascript:`, `data:` and relative URLs are not links to follow); an `a`'s text is its anchor text; (3) an HTML or SVG attachment's links come from the read `htmlAttachmentsOf` already makes (at most 10 attachments, 5 MB each), added to each `HtmlAttachment` as `links`, so no attachment is read twice; (4) PDF links are read from attachments whose type or first bytes (`%PDF-`) say PDF, and from an uploaded PDF document, at most 10 files and their first 10 MiB each: `/URI` literal strings (escapes and balanced parentheses decoded) and hex strings, in the file and in its compressed object streams (`/Type /ObjStm`, inflated with `DecompressionStream("deflate")`, at most 10 MiB inflated per file); an encrypted PDF (an `/Encrypt` entry), a missing object or a file past the bounds is named in `unread`, so the check is partial; (5) a cut plain-text part is read in 64 KiB chunks carrying the last 2 KiB (the longest URL kept) into the next, so a URL across a chunk edge is found once; a cut HTML part streams through `HTMLRewriter`, which needs no overlap; (6) a link keeps its raw text, its parsed `href`, its host in lower-case ASCII and in Unicode for display (`unicodeLabel`), its kind (`href`, `form`, `frame`, `image`, `refresh`, `text`, `pdf`), its part (`summary`, a cut part's key or an attachment's key) and its anchor text, at most 200 characters; links are deduplicated by `href` and anchor text, the first 50 kept and the rest counted in `more`; (7) a plain-text URL is `http://` or `https://`, or a host starting `www.` (read as `http:`), followed by RFC 3986 characters, at most 2,048, its trailing punctuation (`.,;:!?'"`, and an unbalanced closing bracket) left off; (8) `link.text_mismatch` is medium when a link's anchor text names a domain (a host with a public suffix, `tldts`) whose registrable domain differs from the link's own; its detail names the shown domain, the target host, the kind and the part, and the check is partial when links were capped or a file was unread.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T07-s1.md`; correction 2 refined): (9) a document's first `<base href>` that is an absolute `http:` or `https:` URL resolves its relative links and form actions, as a browser does (HTML, the base element), wherever in the document it stands; without one, relative URLs stay out; (10) SVG links are read too: an `a` element's `href`, else its `xlink:href` (SVG 2 linking), with its text as the anchor and the attachment as the part, proven on an SVG fixture; (11) the test checkpoint runs the real `checks()` entry point on stored summaries and artefacts and reads back the stored `link.text_mismatch` evidence and check outcomes: the part named, medium severity, `partial` when capped or unread, and a retried step storing no duplicate; it fails when `linksOf`'s wiring or the check's registration is removed; (12) the fixtures prove each promise apart: a PDF with a literal, a hex and an object-stream `/URI`; a URL split exactly across a 64 KiB chunk edge; two spellings of one URL (host case, Unicode and its A-label) kept once; encrypted, missing and over-limit PDFs named unread; and no mismatch for a shown domain in the same registrable domain, or the Unicode form of the link's own A-label host.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Write `extractLinks(caseView)` in `src/checks/links.ts`. Done when: fixtures yield every link with source and anchor text.
2. Register `link.text_mismatch`. Done when: a link showing `www.bank.example` but pointing elsewhere is medium.

- [ ] Extract from HTML `href`, `src` of forms and frames, `srcset`, `meta refresh`, and plain-text URLs (RFC 3986 with a conservative pattern), keeping anchor text and the source part. Done when: `test/checks/links.test.ts` passes on a fixture with each form.
- [ ] Extract `/URI` actions from PDF attachments by scanning PDF objects for `/A << /S /URI /URI (...) >>`. Done when: a synthetic PDF with two links yields both.
- [ ] Extract links from the full text and HTML of every body part D01 T01 §5 cut for reading (the parsed summary's `truncated`, each part's artefact), read in 64 KiB chunks with a carried overlap so a URL across a chunk edge is kept, within the same 50-link cap. Done when: a fixture whose only harmful link sits past the 1 MiB cut yields that link. Source: D01 T01 §5 plan review, 2026-10-28.
- [ ] Extract links and form actions from HTML and SVG attachments (read as D02 T04 §2 reads them, `htmlAttachments`), each marked with its attachment as the source. Done when: a local login page's form action appears in the link list. Source: D02 T04 §2's start, 2026-10-31.
- [ ] Normalise (lower-case host, punycode to Unicode for display, keep the raw form) and deduplicate, capping at 50 links per case with a note when capped. Done when: the cap test passes.
- [ ] Register `link.text_mismatch` when anchor text contains a domain different from the target's registrable domain. Done when: the fixture yields it.
- [ ] Commit: `checks: URL extraction`

**Test checkpoint:** `pnpm exec vitest run test/checks/links.test.ts` passes and fails if PDF links are missed.

## 2. Redirect expansion in Browser Run

Links are followed in Browser Run, never from the Worker's own network stack against arbitrary hosts, with downloads blocked, a 15-second budget per link, and only http(s) (spec 4.3, risks table: link detonation).

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Write `expandLink(url)` in `src/checks/expand.ts`. Done when: a test against the fixture redirect chain records each hop.
2. Block downloads and non-http(s) schemes. Done when: a link to a download is stopped and recorded.

- [ ] Add exact dependency `@cloudflare/puppeteer` 1.4.0. Done when: `pnpm install` resolves it.
- [ ] Open a page per link with request interception: allow `http:` and `https:` documents, scripts, styles and images; abort downloads (`Content-Disposition: attachment` or binary types), other schemes and requests to private IP ranges. Done when: `test/checks/expand.test.ts` against a local fixture server sees the download aborted.
- [ ] Record each redirect hop (status, location) and the final URL within 15 seconds. Done when: the two-redirect fixture yields three URLs.
- [ ] Host the redirect and landing fixtures on `fixtures.isitlegit.co.za` (fictional brands only, `noindex`, random path prefix; design spec section 11 Fixtures) with `scripts/deploy-fixtures.ts`. Done when: the fixture URLs answer and send `X-Robots-Tag: noindex`.
- [ ] Register `link.redirects` (info, the chain) and `link.final_domain_changed` (medium when the final registrable domain differs from the first). Done when: the live fixture yields both.
- [ ] Commit: `checks: redirect expansion in Browser Run`

**Test checkpoint:** `pnpm exec vitest run test/checks/expand.test.ts` passes and fails if the download request is allowed.

## 3. Landing screenshot and form detection

On the final page, take a screenshot to R2 and look for password fields, card-number fields and forms posting off-domain (spec 4.3). A found form is what triggers the walkthrough (D04 T02 §6).

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Screenshot the landing page. Done when: `art/<case>/render/landing-<n>.png` exists for the fixture.
2. Register `link.credential_form` and `link.card_form`. Done when: the fixture login page yields high and a plain article page yields nothing.

- [ ] Take a 1280 by 800 PNG screenshot of the final page and store it with `putArtefact(kind: "render")`. Done when: the test reads it from R2.
- [ ] Detect `input[type=password]`, inputs named or labelled for card number, CVV or expiry, and forms whose action's registrable domain differs from the page's. Done when: `test/checks/landing.test.ts` flags the login fixture and the card fixture.
- [ ] Register `link.credential_form` (high when the page's domain is a lookalike or not the brand's, else medium) and `link.card_form` (high). Done when: severities match the fixtures.
- [ ] Pass the landing page's visible text to `content.ai_instructions` (D02 T05 §2, `src/checks/ai-instructions.ts`) with the location `landing:` and its URL. Done when: a landing page holding "ignore previous instructions" is a high `content.ai_instructions` item naming the page. Source: D02 T05 §2's start, 2026-10-31.
- [ ] Commit: `checks: landing screenshots and form detection`

**Test checkpoint:** `pnpm exec vitest run test/checks/landing.test.ts` passes and fails if the off-domain form action is not flagged.

## 4. QR code decoding from images and PDF pages

QR codes in images or PDFs hide links from text scanners (spec 4.3). They are decoded with `jsqr` inside the Browser Run page (PDF pages rasterised by `pdfjs-dist` there), and the URLs join the link checks. First on the cut list (spec section 8): if time runs short, this section is cut and the report says QR codes are not checked.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Decode QR codes from image attachments and inline images. Done when: a synthetic image with a QR to a fixture URL yields that URL.
2. Decode from PDF pages. Done when: a synthetic PDF with a QR yields its URL.

- [ ] Load `jsqr` 1.4.0 into the Browser Run page and decode each image (scaled to at most 1600 px). Done when: `test/checks/qr.test.ts` decodes the synthetic QR image.
- [ ] Rasterise up to 5 PDF pages with `pdfjs-dist` 6.4.299 in the page and decode each. Done when: the PDF fixture's URL is found.
- [ ] Add decoded URLs to the link list with source `qr` and register `link.qr` (medium: QR codes in business mail are unusual). Done when: the evidence item names the image or page.
- [ ] Commit: `checks: QR code decoding`

**Test checkpoint:** `pnpm exec vitest run test/checks/qr.test.ts` passes.

## Verification

- The fixture phishing chain yields hops, final domain, screenshot and form evidence; downloads never happen.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
