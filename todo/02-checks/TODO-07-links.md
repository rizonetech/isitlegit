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
- -> XREF: D07 T03 §31 -- the report's card for `link.text_mismatch`, which §1 registers; §1 waits on it, since main's card registry test fails a registered check with no card

## Outcome

- A synthetic mail linking through two redirects to a fictional-brand login page on `fixtures.isitlegit.co.za` yields the redirect chain, the final domain, a screenshot and a "password form" item.
- No file is ever downloaded or executed; a page that tries is recorded and stopped.

**Adjacency:** all=not-applicable (pure evidence producers; shown on the report, D07 T03 §3)

**Adjacency rationale:** These checks only add evidence and artefacts to a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | URL extraction from text, HTML and PDF annotations | D02 T01 §2, D07 T03 §31 | [x] |
| 2 | §2 | Redirect expansion in Browser Run | §1, D00 T01 §5 | [ ] |
| 3 | §3 | Landing screenshot and form detection | §2 | [ ] |
| 4 | §4 | QR code decoding from images and PDF pages | §2 | [ ] |
| 5 | §5 | Automatic and click-time link checks | §1 | [ ] |
| 6 | §6 | Link extraction measured on a corpus | §1 | [ ] |
| 7 | §7 | Redirect fixtures proven live | §2 | [ ] |

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

- [x] Extract from HTML `href`, `src` of forms and frames, `srcset`, `meta refresh`, and plain-text URLs (RFC 3986 with a conservative pattern), keeping anchor text and the source part. Done when: `test/checks/links.test.ts` passes on a fixture with each form.
- [x] Extract `/URI` actions from PDF attachments by scanning PDF objects for `/A << /S /URI /URI (...) >>`. Done when: a synthetic PDF with two links yields both.
- [x] Extract links from the full text and HTML of every body part D01 T01 §5 cut for reading (the parsed summary's `truncated`, each part's artefact), read in 64 KiB chunks with a carried overlap so a URL across a chunk edge is kept, within the same 50-link cap. Done when: a fixture whose only harmful link sits past the 1 MiB cut yields that link. Source: D01 T01 §5 plan review, 2026-10-28.
- [x] Extract links and form actions from HTML and SVG attachments (read as D02 T04 §2 reads them, `htmlAttachments`), each marked with its attachment as the source. Done when: a local login page's form action appears in the link list. Source: D02 T04 §2's start, 2026-10-31.
- [x] Normalise (lower-case host, punycode to Unicode for display, keep the raw form) and deduplicate, capping at 50 links per case with a note when capped. Done when: the cap test passes.
- [x] Register `link.text_mismatch` when anchor text contains a domain different from the target's registrable domain. Done when: the fixture yields it.
- [x] Count the unread parts and files past the first 20 named, as `unreadMore` on `link.text_mismatch`'s coverage item (`detail: { checked: false, more, unread, unreadMore }`) in `src/checks/links.ts`. Done when: `test/checks/links.test.ts` names 20 of 21 unread files and counts 1 more. Source: the app lane's D07 T03 §31 completion review, through the coordinator, 2026-10-31.
- [x] Commit: `checks: URL extraction` Done 2026-10-31: the build commit with the plan review folded in, then the completion review's and nine rounds' fixes after it; CI green on b765c2e6 with D07 T03 §31's card merged.

**Test checkpoint:** `pnpm exec vitest run test/checks/links.test.ts` passes and fails if PDF links are missed.

> **Verified:** 2026-10-31 | §1 | b765c2e650007eaa41f7a21055d73e32c936c5af
> **Review:** `docs/reviews/d02-t07-s1.json`

## 2. Redirect expansion in Browser Run

> **Started:** 2026-11-01T01:54Z

Links are followed in Browser Run, never from the Worker's own network stack against arbitrary hosts, with downloads blocked, a 15-second budget per link, and only http(s) (spec 4.3, risks table: link detonation).

**Corrected 2026-11-01** (from the plan review, `docs/reviews/02-checks/D02-T07-s2.md`): (7) each link has its own outcome and the case counts what it skipped and why, so the checks are partial whenever following was incomplete and a throw keeps the chains already read; (8) the registered checks need card fixtures and interim rendering that is not a text mismatch (D07 T03 §13 owns the richer card); (9) the live proof ends at `example.org` for a changed registrable domain; (10) the download test is response-triggered.

**Corrected 2026-11-01** (from the completion review, `docs/reviews/02-checks/D02-T07-s2.md`): (15) every target's requests are paused at one browser-wide interception and a popup is closed; (16) a page that moves on by itself is watched for QUIET_MS, up to SETTLE_MS, within the link's time, and its hop is the page's own redirect; (17) addresses are kept whole to 2048 characters and the host is read before any cut; (18) the stored evidence carries the stopped downloads, the refusals with their reasons and whether the end was confirmed (an interrupted chain is "last seen"); (19) one clock covers the policy's lookups, the session start and the clean-up, and a session slower than 10 seconds to start is unavailable; (20) the link set the extraction could not complete (cut or unread) keeps both checks partial, never "no links".

**Corrected 2026-11-01** (at build): (11) `expandLink` is proven in a real Chromium in the Node browser project, `test/node/expand-browser.test.ts` (a loopback fixture server, driven through `@cloudflare/puppeteer` over the DevTools protocol exactly as Browser Run is; Worker tests cannot start a server), and the pipeline and check tests are in `test/checks/links.test.ts`; (12) the checks step takes a `read` function for the links (production: `followLinks` on `env.BROWSER`), so the stored-evidence tests supply followed links without a browser; (13) a download that completed is an error for its link, the browser's own `canceled` state being the proof of denial; (14) the redirect fixtures are served by the `isitlegit` Worker itself on the host route (the standing authorisation covers that Worker and that zone), whose deploy runs from main after the gates, so the live proof (the host answering, then a stored case read back) is D02 T07 §7.

**Corrected 2026-11-01** (at start, checked against the repository; the section moved to the app lane, `todo/lanes.json`): (1) checks are pure (D02 T01 §1), so the links are followed by the Workflow's `checks` step, which reads them as `expansionsOf` in `src/checks/expand.ts` beside `domainAges`, puts the result on the case view (`expansions`, null when not read) and lets the two checks read only that; (2) the walkthrough lane's URL policy is reused, not rewritten: `allowedUrl` and `dohResolve` from `src/walkthrough/url-policy.ts` (stamped, D04 T02 §3) refuse an address that is not `http:` or `https:`, has a port, credentials, an IP literal, a local name or a name resolving to a non-public address, and every request the page makes is checked by it before it is allowed; (3) a download cannot be seen at the request stage, so downloads are denied by the browser itself (`Browser.setDownloadBehavior` deny, with `Browser.downloadWillBegin` recorded as the stopped download), as the contained driver does; (4) the work is bounded: at most 5 distinct URLs per case (document links before images, in the case's link order), one page per link, 15 seconds per link and 45 seconds for the case, one browser session closed whatever happens, none when `BROWSER` is absent; (5) the two checks need plain words in `src/web/components/evidence/check-words.ts` (a registered check without them fails `test/web/evidence-cards.test.ts`); (6) the fixtures host is made here and extended by D04 T02 §1, which depends on this section.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Write `expandLink(browser, url, deps)` in `src/checks/expand.ts`. Done when: a test against the fixture redirect chain records each hop.
2. Block downloads and everything the URL policy refuses. Done when: a link to a download is stopped and recorded, and a request to a non-public address never leaves the policy check.
3. Follow the case's links in the `checks` step and read them in two checks. Done when: a case with a redirecting link stores `link.redirects` and, when the final registrable domain differs, `link.final_domain_changed`.

- [x] Confirm exact dependency `@cloudflare/puppeteer` 1.4.0 in `package.json`. Done when: `pnpm install --frozen-lockfile` resolves it (already present from the walkthrough driver, D04 T02 §3).
- [x] Write `expandLink(browser, url, deps)` in `src/checks/expand.ts` (`deps` carries the policy, so the local fixture server, which `allowedUrl` refuses for its port and address, is allowed by the test and by nothing else): one page, `Fetch` interception through the policy for the document, scripts, styles and images (a refused request is aborted and logged), downloads denied and recorded, the main frame's redirect chain read as hops (status, location), the final URL, all within 15 seconds (the page closed when time is up). Done when: `test/node/expand-browser.test.ts` against a local fixture server yields three URLs for the two-redirect chain, stops a response-triggered download (a 200 answer with `Content-Disposition: attachment`, and another with a binary type) by the browser's own denial and stores the stopped download, refuses a non-public name with the policy's reason and ends a stalled page at the limit.
- [x] Write `expansionsOf(browser, links, deps)` in `src/checks/expand.ts` with the bounds in correction 4, returning `{ items: Expansion[]; skipped: { count; why: "past-limit" | "time" }[] }` where each `Expansion` carries its own outcome (`done`, `blocked` with the policy's reason, `timeout` or `error`) and the chain it had when it ended. Done when: the test shows 5 URLs followed from 8 with the other 3 counted as skipped for the cap, images after documents, the case stopping at 45 seconds with the unreached links counted as skipped for time, a link that threw keeping the chains of the links completed before it, and the session closed on a throw.
- [x] Add `expansions` to the case view (`src/checks/case-view.ts`) and fill it in the `checks` step (`src/pipeline/analysis-workflow.ts`) from `env.BROWSER`: null only when following was unavailable (no binding, or the session could not start), which the checks report as not run for that reason, apart from a case with no links (not applicable); a throw after some links keeps the completed ones. Done when: `test/pipeline` shows a case with a link storing the evidence, a case without the binding finishing with the checks not run and the reason stored, and a case whose second link failed storing the first link's chain.
- [x] Register `link.redirects` (info, the chain) and `link.final_domain_changed` (medium when the final registrable domain differs from the first) in `src/checks/links.ts`, with plain words in `src/web/components/evidence/check-words.ts`. Both checks are partial whenever the expansions are (links skipped for the cap or for time, a link that timed out or errored, a link the policy blocked), saying how many and why, so an incomplete investigation never reads as a clean one. Done when: `test/checks/links.test.ts` yields both for a hand-built cross-domain chain, none for a link that does not redirect, `link.final_domain_changed` for a change of registrable domain and not for a change of subdomain or path, and the partial reasons for each of those incomplete outcomes read back from stored outcomes.
- [x] Draw the two checks in the report's evidence cards: fixtures for both in `test/web/evidence-cards.test.ts` (it requires one per registered check) and the `link` renderer in `src/web/components/evidence/` showing the chain and the changed domain in plain words, never as a text mismatch (D07 T03 §13 owns the richer redirect card; this is the interim). Done when: the test renders each card with the actual hops and the domain change and neither reads as a mismatch.
- [x] Serve the redirect fixtures from the Worker on `fixtures.isitlegit.co.za` (fictional, `noindex` and `robots.txt` on every answer, a secret random path prefix, a custom-domain route that makes the DNS record under the standing authorisation recorded in D04 T02 §1), with `scripts/deploy-fixtures.ts` setting the prefix and verifying the host. The chains are two redirects to `https://example.org/` (IANA's reserved documentation domain, so a changed registrable domain needs no other zone of ours) and a same-host chain ending on a labelled page. Done when: `test/checks/fixtures-host.test.ts` passes through the Worker's entry, including the script's own verification passing and failing on a hop that loses `noindex`; the live host answering is D02 T07 §7.
- [x] Move the live proof out: the host answering after the production deploy, and one stored case read back, are D02 T07 §7. Done when: §7 exists in this file, depends on this section, and `validate` passes.
- [ ] Commit: `checks: redirect expansion in Browser Run`

**Test checkpoint:** `pnpm exec vitest run --project worker test/checks/links.test.ts test/checks/fixtures-host.test.ts test/web/evidence-cards.test.ts` and `pnpm exec vitest run --project browser test/node/expand-browser.test.ts` pass, and the browser file fails if the browser's download denial is removed, if the per-request policy check is removed, if the page-redirect watch is removed or if an address is cut before its host is read, and the worker files fail if a skipped or timed-out link stops being counted or a stopped download is dropped from the stored evidence.

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

## 5. Automatic and click-time link checks

Filed 2026-10-31 from §1's completion review (out of scope): a member must forward or upload each message, and a link is judged once, when the case is checked. Mail protection services check every message once configured and check a link again when it is clicked. Closing that gap needs a design decision (consent, which mailboxes, and how a click reaches IsItLegit) owned by intake (D01) with the report and settings surfaces (D07).

**Phase:** 7
**Needs:** owner-decision
**Surface:** no

**Build order:**

1. Decide and record the design. Done when: `docs/specs/` holds a dated design for opted-in automatic checking and click-time rechecking, approved by the operator, naming the D01 and D07 sections that build it.

- [ ] Write the design in `docs/specs/YYYY-MM-DD-automatic-and-click-time-checking-design.md`: consent, mailbox scope, the click path (a rewritten link or a mailbox add-in), and the time a click may wait. Done when: the operator's approval is recorded in it.
- [ ] File the D01 and D07 sections the design names through `add-todo`. Done when: each is in the plan with its Depends On.
- [ ] Commit: `docs: automatic and click-time link checking designed`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes with the filed sections.

## 6. Link extraction measured on a corpus

Filed 2026-10-31 from §1's completion review (out of scope): §1's tests prove chosen examples, not how many links extraction finds in real-shaped mail, how many it invents, or how long it takes on large and damaged files.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Measure extraction. Done when: a labelled, licensed, synthetic corpus of messages and PDFs with their links listed gives recall, false links and p50/p95 extraction time, recorded with the commit measured.

- [ ] Build `eval/sets/links/` (labels in D08 T01's format, each file's expected links) with HTML, text, SVG and PDF samples, damaged and cap-padded ones included, recorded in `eval/DATASETS.md`. Done when: `loadSets` reads it.
- [ ] Measure `linksOf` on it in `eval/links.ts`: recall, false links, and p50 and p95 time per case. Done when: `docs/eval/links.md` records the figures and the commit, with no case marked complete that was not.
- [ ] Commit: `eval: link extraction measured`

**Test checkpoint:** `node eval/links.ts` prints recall, false links and timings for the set.

## 7. Redirect fixtures proven live

Split from §2 on 2026-11-01: the redirect fixtures host (`src/fixtures/redirects.ts`, route and script built in §2) goes live with the Worker's next production deploy from main, which this lane does not run; the proof that the deployed host answers and that a stored case reads back the live chain belongs after that deploy.

**Phase:** 3
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Deploy and set the prefix. Done when: `node scripts/deploy-fixtures.ts --verify` reports every check ok against the live host.
2. Follow the live chain once. Done when: a stored case's evidence reads back the live redirects and the changed registrable domain.

- [ ] Run `node scripts/deploy-fixtures.ts --create` (a prefix in the vault item "IsItLegit fixtures prefix") and `--set` after the production deploy that carries the route, then `--verify`. Done when: every check reports ok and the host sends `X-Robots-Tag: noindex, nofollow`.
- [ ] Follow the live chain once through `followLinks` on the deployed Browser Run binding (`scripts/` one-off or the smoke route), storing the case's evidence. Done when: `link.redirects` carries the two hops and `link.final_domain_changed` the move to `example.org`, and the same-host chain yields no change, read back from the stored evidence.
- [ ] Commit: `checks: redirect fixtures proven live`

**Test checkpoint:** `node scripts/deploy-fixtures.ts --verify` exits 0 against the live host.

## Verification

- The fixture phishing chain yields hops, final domain, screenshot and form evidence; downloads never happen.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
