---
schema_version: 1
id: payment-documents
domain: 06-invoice
status: active
title: "TODO-02 -- Payment Document Check"
track: day-5
---

# TODO-02 -- Payment Document Check

> **Goal:** A member uploads an invoice, a proof of payment (POP) or a bank confirmation letter on its own (web upload, or mail to `check@` with only a PDF or image) and gets a verdict built from file forensics (producer, incremental updates, fonts, dates, pasted images), Muse Spark extraction and layout comparison, and ledger and registry matching, with the fixed POP action "confirm the money has cleared in your own banking app before releasing goods" and the stated limit that a POP check cannot prove payment.

> **Current state:** Measured 2026-10-26 20:00 SAST. Uploads route PDFs and images as `source_kind = document` (D01 T03 §1). Doctored pairs for the eval come from Muse Image (§4).

## Inputs

- Design spec 4.5a (payment document check: forensics, extraction, match, fixed action, limit), 4.9 (Muse Image doctored-document test set), 2b (paid Protect feature; the trial unlocks it).
- ISO 32000-1 (PDF: incremental updates section 7.5.6, document information dictionary section 14.3.3, font resources).
- -> XREF: D08 T01 §3 -- the eval set that uses this file's doctored pairs
- -> XREF: D07 T03 §30 -- the report's cards for the five document.forensics checks §3 registers; §3 waits on them, since main's card registry test fails a registered check with no card

## Outcome

- A doctored POP fixture (amount edited, an incremental update after creation, a substituted font in the amount) is flagged with each forensic finding; its genuine twin is not.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (no tunables; limits are fixed in code with the spec reference); reporting=applicable @ D07 T04 §2; notifications=not-applicable (results show on the report; uploads send no mail); permissions=applicable @ D01 T03 §1; audit=applicable @ D01 T01 §7; exchange=not-applicable (nothing is imported or exported); reverse=not-applicable (analysis only)

**Adjacency rationale:** Document cases are ordinary cases on the report and in the cases list; the upload session is the permission boundary.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | PDF forensics | D02 T01 §2 | [x] |
| 2 | §2 | POP and bank letter extraction, layout comparison | §1, D06 T01 §1 | [x] |
| 3 | §3 | Standalone document path with the fixed | §2, D01 T03 §1, D07 T03 §30 | [x] |
| 4 | §4 | Muse Image doctored document pairs | §2 | [x] |
| 5 | §5 | More PDF encodings and protected files | §1 | [x] |
| 6 | §6 | AES-encrypted PDFs, empty password | §5 | [x] |
| 7 | §7 | Diverse doctored pairs with verified truth | §4 | [ ] |
| 8 | §8 | Native PDF forensic limits diagnosis | §1, §5, §6 | [ ] |
| 9 | §9 | PNG encoding at the doctored fixture producer | §4 | [x] |

## 1. PDF forensics

Deterministic file evidence (spec 4.5a): producer and creator against the claimed issuer, incremental updates (edits saved after the original), mixed or substituted fonts in amount and account areas, creation and modification dates against the document date, and images placed over text.

> **Started:** 2026-10-31T09:24Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) checks are pure functions of the case view (`src/checks/registry.ts`), and file bytes reach them only through a field the `checks` step fills from R2 (as `attachmentRisksOf` does, `src/checks/attachment-risk.ts`); the view, the step and the pipeline's registry are checks-lane files (`src/checks/case-view.ts`, `src/pipeline/analysis-workflow.ts`, `src/checks/index.ts`), so this section ships the pure analyser and its evidence, and the wiring into the pipeline moves to §3, which already changes the Workflow (asked of the coordinator 2026-10-31); (2) no PDF library is a dependency and none is added (spec 11, dependency licences): the analyser is a bounded reader of its own, linear in the file's size, with FlateDecode through the Workers `DecompressionStream`; (3) the fixtures are built in code by a small PDF writer under `test/invoice/` at test time, fictional banks only, so no binary is committed; (4) "bank-issued" is read from the document's own text (a bank name or a payment-confirmation title), since the model's document type arrives only in §2; (5) a linearized file's first `%%EOF` is part of its first revision, so a genuine linearized file is not counted as edited (ISO 32000-1 Annex F).

**Phase:** 5
**Needs:** none
**Surface:** no

**Corrected 2026-10-31** (plan review, 5 P1 and 5 P2, `docs/reviews/06-invoice/D06-T02-s1.md`): (6) objects are resolved through the cross-reference chain (tables and streams, `/Prev`, `/XRefStm`, free entries, generations), revisions are counted as the chain's sections with a linearized file's first-page section structurally excluded, and a scan of `N G obj` is only the fallback for a damaged chain, said as partial; (7) every detector reports its coverage (`ran`, `partial` or `unavailable` with a reason), exported for §3, and missing content is never a clean result; (8) the work is bounded by one shared budget (tokens, decoded bytes, traversal), with cycle detection in the page tree and Form XObjects, and the image-to-text comparison capped; (9) the content reader (`src/invoice/pdf-content.ts`) is its own tested step; (10) false positives are controlled by construction: a revision that only signs, or only changes metadata, is not an edit; dates count only a modification after creation; the issuer is a bank only when page 1's heading says so; a font substitution needs the document's own amount style to differ; an overlay needs visible text painted under an opaque, unclipped image; and a high severity needs two independent groups (history, tool, page) to agree; (11) fixtures come from two independent generators besides the code writer: Ghostscript 10.06 `pdfwrite` (AGPL-3.0, used only to make files) and Chromium's Skia PDF (BSD-3-Clause), made by `test/node/make-pdf-forensics.ts` and committed with their provenance in `test/fixtures/pdf-forensics/PROVENANCE.md`, fictional banks only; (12) the comparison baseline is peepdf and ExifTool, recorded in `docs/frontier-log.md`; broader false-positive measurement on genuine documents is D08 T02 §6's (**Corrected 2026-10-31:** was D08 T01 §3, the synthetic mail set; the eval lane filed D08 T02 §6).

**Build order:**

1. Write `src/invoice/pdf.ts` (the bounded object reader), `src/invoice/pdf-content.ts` (what each page draws) and `src/invoice/forensics.ts` (the findings and their evidence). Done when: each forensic fixture yields its finding, each genuine and control fixture yields none, and each hostile fixture ends inside its budget with a partial reason.

- [x] Write `readPdf(bytes)` in `src/invoice/pdf.ts`: the last `startxref`, the chain of cross-reference tables and streams through `/Prev` and `/XRefStm` (PNG predictors for cross-reference streams, ISO 32000-1 section 7.5.8), free entries and generations honoured, compressed object streams (7.5.7), FlateDecode streams, and a scan of `N G obj` only when the chain is damaged, said in `unread`. Done when: `test/invoice/pdf.test.ts` resolves a replaced object to its newer definition and a freed object to nothing, reads a hybrid-reference file and a cross-reference-stream file, ignores `N G obj` and `%%EOF` bytes inside a stream, and reads a file with a broken chain by the scan with a partial reason. Done 2026-10-31: `src/invoice/pdf.ts` `readPdf`, `readChain`, `scanObjects`; `test/invoice/pdf.test.ts`.
- [x] Return typed reader outcomes instead of throwing: `encrypted`, an unsupported filter or predictor, a damaged Flate stream, a truncated object, a reference to a missing object, and a file over `MAX_PDF_BYTES`, each a named reason in `unread`. Done when: `test/invoice/pdf.test.ts` has one fixture per outcome and none throws. Done 2026-10-31: `note` reasons in `src/invoice/pdf.ts`; `test/invoice/pdf.test.ts` "names an encrypted file" and "names a truncated object".
- [x] Bound the work with one budget shared by the reader and the content reader (`MAX_TOKENS`, `MAX_TOTAL_DECODED` counted before buffering, page-tree and Form depth, a visited set against reference cycles, `MAX_OVERLAP_PAIRS` for the image-to-text comparison). Done when: a self-referencing page tree, a Form that draws itself, a decompression bomb, 20,000 nested arrays and 5,000 images over 20,000 runs each end with a partial reason, and the test asserts each takes under one second in workerd. (**Corrected 2026-10-31**, review round 3: the proof of bounded work is the report's `work` counters, asserted linear in the input; wall-clock is a backstop of three seconds, since the shared machine and CI runners under load pushed a linear one-second analysis past a second.) Done 2026-10-31: `Budget`, `OverBudget`, `MAX_FORM_DEPTH`, `MAX_OVERLAP_PAIRS`; `test/invoice/forensics.test.ts` "bounded work on hostile files".
- [x] Write `readContent(file)` in `src/invoice/pdf-content.ts`: the graphics state (`q`, `Q`, `cm`), text objects and positioning (`BT`, `Td`, `TD`, `Tm`, `T*`, `TL`), text showing (`Tj`, `TJ`, `'`, `"`) with each run's font, size, render mode and box, fonts' widths, `ToUnicode` CMaps and `/Differences` (ISO 32000-1 section 9.10), content arrays, Form XObjects with their matrices and resources, image XObjects and inline images with their boxes, clipping rectangles (`re W n`) and soft masks or constant alpha below 1 marked transparent. Done when: `test/invoice/pdf-content.test.ts` reads the text and positions of a `ToUnicode` Identity-H font, a `/Differences` font, a `TJ` with kerning, a content array and a nested Form, and an image-only page reports its text unavailable. Done 2026-10-31: `src/invoice/pdf-content.ts`; `test/invoice/pdf-content.test.ts`.
- [x] Count revisions as the cross-reference chain's sections (ISO 32000-1 section 7.5.6), the first-page section of a linearized file not counted (Annex F), and classify each update: one that adds only a signature (`/ByteRange`) or only changes `Info` or `Metadata` is not an edit, content changed after a signature's byte range is the strongest edit. Done when: `test/invoice/forensics.test.ts` finds an edit in the edited fixture and the incrementally updated linearized fixture, and none in the genuine, linearized, signed and metadata-only fixtures. Done 2026-10-31: `revisionsOf`, `updateKind`, `drawnObjects` in `src/invoice/forensics.ts`; tests "revisions".
- [x] Read the information dictionary and XMP for `Producer`, `Creator`, `CreationDate`, `ModDate`, and decide the issuer from page 1's heading (a short line in its top quarter naming a proof of payment, payment confirmation or bank confirmation letter), `unknown` when no heading says so; flag a consumer editor (an online or desktop PDF editor, a word processor or a print driver) only when the issuer is a bank. Done when: fixtures yield the finding for an edited bank POP and none for a supplier invoice made in a word processor that names its bank, nor for an invoice whose body says "please send proof of payment". Done 2026-10-31: `metadataOf`, `issuerOf`, `producerOf`, `EDITORS`; tests "producer".
- [x] Compare dates at day granularity in the offset each date states, with one day's tolerance: flag a modification more than five minutes after creation that falls after the payment date the document states, and a proof of payment created before the payment it confirms; say `unavailable` when the document states no date or the metadata has none, and record conflicting Info and XMP dates in the detail. Done when: fixtures yield both findings, and a genuine POP downloaded a month after payment (created and modified the same minute) yields none. Done 2026-10-31: `datesOf`, `pdfDate`, `isoDate`, `statedDay`; tests "dates".
- [x] Flag a font substitution: a font family used only on amount or account lines, beside other amount or account lines of the same document drawn in another family, or a second subset of the same font on the same page used only there. Done when: the substituted-font fixture yields it naming both fonts and the line, and a bold total in the body family, a numeric font used for every amount, and merged pages with different subset tags yield nothing. Done 2026-10-31: `fontsOf`, `fontFamily`; tests "fonts".
- [x] Flag an overlay: an opaque, unclipped image painted after visible text (render modes other than 3 and 7) and covering at least half of that text's box, on the same page. Done when: the pasted-image fixture yields it naming the covered text, and a logo clear of the text, a page-size background drawn before the text, a scanned page with invisible OCR text, a clipped image and a soft-masked image yield nothing. Done 2026-10-31: `overlayOf`; tests "overlay".
- [x] Produce the evidence drafts with `forensicsEvidence(report, { key, filename })`, one item per finding kind and file (`document.forensics.revisions`, `.producer`, `.dates`, `.fonts`, `.overlay`, exported as `FORENSIC_CHECKS` for §3), each with a plain-language summary that claims no more than the finding, and a detail naming the page, line or object, and the values compared; medium each, high when findings from two of the groups history (revisions, dates), tool (producer) and page (fonts, overlay) agree; and `forensicsCoverage(report)` giving each check's `ran`, `partial` or `unavailable` reason. Done when: the doctored fixture's items are high and pass `evidenceIn` for a registry holding `FORENSIC_CHECKS`, revisions and dates alone stay medium, the genuine fixture has none, a 70 KB filename, hostile producer and font names and a file with every finding stay inside the summary and detail limits, and an unreadable file yields coverage reasons and no finding. Done 2026-10-31: `forensicsEvidence`, `forensicsCoverage`, `FORENSIC_CHECKS`; tests "evidence and coverage".
- [x] Write `test/node/make-pdf-forensics.ts` producing the fixtures with the test writer, Ghostscript `pdfwrite` and Chromium's PDF output, each stamped "SYNTHETIC TEST DOCUMENT" with fictional banks, and `PROVENANCE.md` naming each file's generator, version and licence. Done when: every fixture the tests name exists, and each detector is exercised on at least one Ghostscript or Chromium file. Done 2026-10-31: eight files and `PROVENANCE.md`; `test/invoice/forensics-generated.test.ts` exercises every detector on a Ghostscript or Chromium file. (**Corrected 2026-10-31:** moved from `test/fixtures/pdf-forensics/make.ts`, a Node script the Worker type check cannot read.)
- [x] Record what peepdf and ExifTool report for the doctored and genuine fixtures beside what `forensicsEvidence` reports, in `docs/frontier-log.md` (each tool run from its own folder outside the repository; a tool that cannot be installed here is described from its documentation and said to be). Done when: the entry exists, naming what each tool sees and what only this analyser explains. Done 2026-10-31: `docs/frontier-log.md` entry of 2026-10-31 (peepdf-3 and ExifTool 13.60, both run outside the repository).
- [x] Close the completion review's reproductions (`docs/reviews/06-invoice/D06-T02-s1.md`): an update compared with what it replaced (`definitionAt`, `canonical`), Form graphics state and zero-alpha text, coverage after missing or damaged parts, damaged object-stream headers, generations, `endobj` inside a string, XMP serialisations, the one-day tolerance both ways, linear line grouping, and `LIMITS` on every finding. Done when: `test/invoice/forensics-completion.test.ts` passes and 12 of its 13 tests fail on the reviewed candidate `827dfa36`. **Added 2026-10-31** (completion review).
- [x] Commit: `invoice: PDF forensics`

**Test checkpoint:** `pnpm exec vitest run test/invoice/pdf.test.ts test/invoice/pdf-content.test.ts test/invoice/forensics.test.ts test/invoice/forensics-completion.test.ts test/invoice/forensics-generated.test.ts` passes, and fails if incremental updates are not counted, if a signed-only update is counted as an edit, or if any detector is removed. (**Corrected 2026-10-31**, completion review: the completion and generated-fixture files added.)

> **Verified:** 2026-10-31 | §1 | 140d07c166e58a33a6fd1ce9b1752179ef888f2e
> **Review:** `docs/reviews/d06-t02-s1.json`

## 2. POP and bank letter extraction, layout comparison

Muse Spark (PDF and image input, JSON schema) returns document type, issuer bank, amount, dates, reference and bank fields; for a POP, it compares the layout and wording with a genuine synthetic sample from the same fictional bank and lists differences (spec 4.5a).

**Corrected 2026-10-31** (the eval lane's D08 T03 §1, `docs/frontier-log.md`): on 20 synthetic invoices Muse Spark at high effort caught 4 of 4 typeface swaps but 0 of 3 spacing edits and 0 of 3 recompressed patches, and each of its 4 detections also wrongly called an unchanged branch code edited. Spark therefore reads fields and layout and never claims an edit: `document.layout_mismatch` is worded as a difference from the bank's genuine sample for the member to confirm, never as evidence of tampering, and carries that limit; tamper evidence stays with the deterministic forensics of §1.

> **Started:** 2026-11-02T17:50Z

**Corrected 2026-11-02** (at start, checked against the tree): (1) no `ref/pop/` R2 prefix or reference store exists yet, and the genuine fictional-bank POPs in the tree are §1's fixtures (`test/fixtures/pdf-forensics/gs-genuine-pop.pdf`, `chromium-pop.pdf`, Kestrel Bank); this section defines the reference port `referenceOf(issuer)` returning the genuine sample's bytes or null, the stubbed test supplies the §1 fixture through it, and the production R2 read under `ref/pop/<issuer slug>.pdf` is wired where the bucket reaches the step, in §3. (2) The evidence items are drafts in the `invoice` producer family (`LATER_PRODUCERS` already holds it, §1 of D06 T01), exported as draft builders like `forensicsEvidence` in §1 here; registering them in the Workflow and the report cards is §3 with D07 T03 §30, so this section proves the drafts pass `evidenceIn` for a registry holding them. (3) The beneficiary match reuses the §3-of-D06-T01 machinery: `matchSupplierAccount` against the ledger and `matchBankAccount` against the registry (match or no match only, rate-limited, never a registered detail read out), with a comparison that cannot run stated as its own outcome, never a mismatch. (4) The call mirrors `extractInvoiceFields`: `muse-spark-1.3`, reasoning low, `structured()` with the zod schema, the document as inline `input_file`, its text layer in an untrusted block, and typed failures with the infrastructure flag; an image document is sent as the client's image input the same way. (5) Layout differences are asked only when a reference exists: with none, no `document.layout_mismatch` item is written and the type item states `layout_checked: false` with the reason, never a clean comparison.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Define `PaymentDocument` and the call. Done when: a stubbed test extracts the fields and the layout differences.

- [x] Define `PaymentDocument` (`type` invoice, pop, bank_letter, other; `issuer`, `amount_cents`, `paid_at`, `reference`, `beneficiary` fields, `layout_differences` array). Done when: the schema is non-recursive and used with `structured()`. Done 2026-11-02: `PaymentDocument` in `src/invoice/payment-doc.ts`, used by `extractPaymentDocument` through `structured()`. **Corrected 2026-11-02** (review round 3): `layout_differences` holds structured aspects (`logo`, `layout`, `wording`, `amounts`, `dates`, `bank_details`, `other`) worded by code in `ASPECT_WORDING`, never model prose, so no difference can assert an edit or tampering.
- [x] Complete the schema (plan review gap 3): `currency`, type-appropriate dates (`paid_at` for a POP, `issued_at` for a letter or invoice), a structured `beneficiary` (`name`, `account_number`, `branch_code`, each nullable, digit strings keeping leading zeros), bounded strings and a bounded `layout_differences` array, every absent or unreadable field a null. Done when: the stubbed test extracts all three document types with missing optional fields, and malformed model output (a recursive or oversized differences list, a non-digit account) is refused by the schema.
- [x] Order the call (plan review gap 1): extract first, then `referenceOf(issuer)` for a POP only, then a second comparison call carrying the document and the selected reference's bytes; an unknown issuer, a non-POP, an absent reference or a failed reference read sends no comparison and states `layout_checked: false` with its reason. Done when: `test/invoice/payment-doc.test.ts` proves each branch and that the comparison call carries the selected bank's bytes.
- [x] Send the document and, for a POP, the matching genuine reference from `ref/pop/<bank>.pdf` in R2 (synthetic fictional banks only). Done when: `test/invoice/payment-doc.test.ts` checks both parts are sent. Done 2026-11-02: the comparison call carries the document and the selected reference (two `input_file` parts asserted). The reference port is `ReferencePort`; its R2 read wires in §3 (correction 1).
- [x] Register `document.type`, `document.layout_mismatch` (medium, worded as a difference to confirm with its limit, never as an edit; D08 T03 §1), and run the ledger and registry match on beneficiary details (`document.beneficiary_mismatch`, critical). Done when: the stub cases yield each. Done 2026-11-02: `paymentEvidence` and `beneficiaryEvidence` in `src/invoice/payment-doc.ts`; stub cases yield `document.type`, `document.layout_mismatch` and `document.beneficiary_mismatch`.
- [x] Resolve the beneficiary before matching (plan review gap 2): the extracted beneficiary name and account resolve through `findSupplier` in the case's organisation (a POP payable to the uploading business itself resolves to no supplier and states that), an ambiguous resolution states `supplier-ambiguous`, and the registry side runs only for a protected supplier as in D06 T01 §3; a comparison that cannot run writes `document.comparison_unavailable` with its reason kind, never a match and never a mismatch, and no registered detail ever appears in an item. Done when: the test proves target selection, another organisation's supplier never resolving, missing baselines, the registry rate limit, and match versus no-match on both sides.
- [x] State extraction failures as evidence, never as a clean result (plan review gap 4): a refused, invalid, budget-exhausted, provider-failed or unreadable document writes a `document.not_checked` draft with `checked: false` and the reason kind, which §3's verdict path reads as a partial report; a retry that succeeds replaces it. Done when: the stubbed test drives each failure kind and reads the draft back.
- [x] Shape the drafts for their report owner (plan review gap 5): the card owner for extracted document fields and layout findings is D07 T03 §15 (not §30, which holds only the five forensic cards); each draft's detail carries the attachment key, the document type, masked beneficiary (`***<last3>`), the layout differences and the limit wording, so §15's cards read only the draft. Done when: the test asserts each draft's detail keys and that no full account number appears.
- [x] Prove the contrasts (plan review gap 6): genuine versus changed documents, ledger match versus no-match, PDF and image requests, no-reference suppression, each failure kind, the untrusted-text boundary (document text only inside its untrusted block), and layout wording that keeps its limit and never claims an edit. Done when: removing or inverting any of those behaviours fails `test/invoice/payment-doc.test.ts`.
- [x] Commit: `invoice: payment document extraction and layout comparison`

**Test checkpoint:** `pnpm exec vitest run test/invoice/payment-doc.test.ts` passes.

> **Verified:** 2026-11-02 | §2 | 51ff256a594ddaa085e380d7534defee155a4f72
> **Review:** `docs/reviews/d06-t02-s2.json`

## 3. Standalone document path with the fixed

A document case skips the mail checks and runs forensics, extraction and matching; the verdict carries the fixed POP action and the limit statement (spec 4.5a). Mail to `check@` whose body is empty and which carries only a PDF or image is treated as a document case too.

> **Started:** 2026-11-02T18:30Z

**Corrected 2026-11-02** (at start, checked against the tree): (1) the document work ships as `documentStep` in `src/invoice/document-step.ts` and is wired into the production `AnalysisWorkflow` through `invoiceStep` and `recordInvoiceNotRun` in `src/invoice/step.ts` (`AnalysisWorkflow` calls `invoiceStep` at `src/pipeline/analysis-workflow.ts:498`), routing standalone document cases (`source_kind = document` or `image`, and parsed `mail` cases with an empty body and one PDF or image attachment) to `documentStep` and running PDF forensics on PDF attachments of non-standalone mail cases without modifying checks-lane files. (2) The fixed POP action already triggers in `fixedActionsFor` (`src/agent/loop.ts`) on a `document.proof_of_payment` item, so the document step writes that item (info, with the limit wording in its detail) for a POP: no loop change is needed. (3) The limit statement is a `document.limit` info item written for every document case, not only POPs, since the forensics and layout limits apply to each.

**Corrected 2026-11-03** (plan review, 3 P1 and 2 P2, `docs/reviews/06-invoice/D06-T02-s3.md`): (4) when an organisation lacks the `payment-document` feature (`hasFeature`), `documentStep` makes zero model calls and persists a `document.not_checked` item (`reason: "plan-required"`, `required_plan: "protect"`, and recovery guidance to upgrade in organisation settings and retry the case) so the member report explains why the document was not checked and how to recover, replaced on retry after upgrading; (5) `saveDocumentEvidence` validates `DOCUMENT_CHECKS` via `StoredEvidence` and persists `document.*` items directly to D1 under `producer = 'document'` using `addEvidence`'s atomic sequence-reuse and replacement batch, coexisting with `saveEvidence` (`producer = 'checks'`, including registered `FORENSIC_CHECKS` without duplicating forensic items) and replacing stale `producer = 'document'` items on retry; (6) `r2ReferenceOf(bucket)` reads `ref/pop/<issuer slug>.pdf` from R2 so selected reference bytes reach `compareLayout`, and `evaluateDocumentCase` / `runAgent` + `EvidenceCards` prove end-to-end persistence, layout comparison, ledger and registry beneficiary matching (including `document.beneficiary_mismatch` constraining the final verdict to `malicious`), `POP_ACTION`, and `DOCUMENT_LIMIT` rendering across POPs, invoices and bank letters for PDF, PNG, JPEG and WebP inputs; (7) extraction refusal, invalid output, provider failure, unreadable files and incomplete PDF forensic coverage each persist `document.not_checked` with `checked: false`, producing a partial report (`PARTIAL_HEADLINE`, `PARTIAL_MEANING`, confidence capped at `0.5`) rather than an ordinary clean result, and a successful retry replaces the stale failure evidence.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Route and evaluate standalone document cases in `src/invoice/document-step.ts`. Done when: an uploaded or empty-body emailed POP, invoice or bank letter runs forensics, extraction, R2 reference layout comparison and beneficiary matching into real D1 persistence and report rendering.

- [x] Classify standalone document cases (`isStandaloneDocumentCase`) for `source_kind = document` or `image` and for mail with an empty body and one PDF or image (PNG, JPEG, WebP or PDF), and wire R2 reference lookup (`r2ReferenceOf(bucket)` reading `ref/pop/<issuer slug>.pdf`) into `documentStep`. Done when: `test/invoice/document-path.test.ts` covers `document` and `image` uploads and empty-body emails across PDF, PNG, JPEG and WebP, and proves the selected R2 reference bytes reach the comparison call. (**Corrected 2026-10-28**, D01 T03 §1's plan review P1 3: uploads record images as `source_kind = image`, so an uploaded screenshot of a POP takes this route too: `document` or `image`, with PNG, JPEG and WebP payment-document fixtures beside the PDF.)
- [x] Run the PDF forensics of §1 on every PDF of the case, persist all `document.*` items in D1 via `saveDocumentEvidence` (`producer = 'document'`), coexist with registered `FORENSIC_CHECKS` in `saveEvidence` without duplicating forensic items, and record incomplete PDF forensic coverage as `document.not_checked` (`checked: false`). Done when: `test/invoice/document-path.test.ts` stores the doctored fixture's `document.forensics.*` items in D1 and none on the genuine twin's, coexists with `saveEvidence` (`FORENSIC_CHECKS`), and replaces stale `document` items on retry. **Added 2026-10-31** (moved from §1 at its start; **Corrected 2026-11-03**, plan review gaps 1 and 3).
- [x] Add the fixed POP action (`POP_ACTION` from `src/invoice/fixed-actions.ts`, D07 T03 §2) and the info item "This check can show a document is likely altered. It cannot prove that a payment was made.", and prove end-to-end verdict, floor, partial-report and `EvidenceCards` rendering across POPs, invoices and bank letters (including rule-based fallback, ledger and registry beneficiary matching, and extraction/provider/unreadable/forensic-coverage failure states replaced on retry). Done when: `test/invoice/document-path.test.ts` reads back the stored verdict and rendered `EvidenceCards` for POPs, invoices and bank letters, proves `document.beneficiary_mismatch` forces a `malicious` verdict, proves every failure state yields a partial report replaced on retry, and proves every document type renders `DOCUMENT_LIMIT` and POPs carry `POP_ACTION`.
- [x] Gate the payment document path on `payment-document` (`requireFeature` for an upload, `hasFeature` for an emailed document, D07 T02 §8) with a persisted `document.not_checked` refusal (`reason: "plan-required"`, `required_plan: "protect"`, and recovery guidance) and zero model calls when unentitled. Done when: a free organisation's case makes zero model calls, persists the `plan-required` refusal that surfaces in the partial report's reasons, and is replaced on retry once entitled. Source: D07 T02 §8 and D06 T02 §3 plan reviews.
- [x] Commit: `invoice: standalone payment document path`

**Test checkpoint:** `pnpm exec vitest run test/invoice/document-path.test.ts` passes and fails if a POP case lacks the limit statement.

> **Verified:** 2026-11-04 | §3 | 348f8346f2f35dad2c382c387ea8259b52d8836d
> **Review:** `docs/reviews/d06-t02-s3.json`

## 4. Muse Image doctored document pairs

Muse Image (`muse-image-1.0`, editing) edits our synthetic invoices and POPs of fictional companies and banks (changed amounts, account numbers, dates), each stamped SYNTHETIC, giving genuine and doctored pairs for the eval (spec 4.9). If the usage policy filter refuses an edit, that pair is made in code and the refusal is recorded.

> **Started:** 2026-11-02T18:55Z

**Corrected 2026-11-02** (at start, checked against the tree): (1) genuine sources are the §5 synthetic invoices of D06 T01 rendered to images plus the genuine POP fixtures of §1 here, 20 documents in all, each already stamped SYNTHETIC with fictional banks; the doctored output keeps that stamp or the pair is made in code. (2) Spend: `muse-image-1.0` is priced per image in `src/meta/models.ts`; the cap for this section is stated in the lane outbox before any paid call and never raised, and every call goes through `metaRaw` with the budget guard, so a refusal or an over-cap call sends nothing. (3) The dry run is the default: without `--confirm-credit` the script prints the 20 requests and calls nothing.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Generate 20 doctored images from 20 genuine synthetic documents. Done when: `eval/sets/payment-docs/` holds 40 files with labels and provenance.

- [x] Write `scripts/fixtures/make-doctored.ts` calling `/images/edits` through `metaRaw` (plan review gap 2: the client refuses any other path) with an edit instruction per document and the budget guard. Done when: a dry run prints 20 requests. Done 2026-11-02: dry run printed 20; the live branch is proven by the run and `test/node/make-doctored.test.ts`.
- [x] Create the 20 genuine sources (plan review gap 1): `make-doctored.ts` first draws 20 genuine synthetic documents (invoices, POPs and bank letters from fictional suppliers and banks, varied amounts, accounts and dates) as SVG rasterised by `sharp` (the eval frontier's pattern), each visibly stamped SYNTHETIC; no existing tampered fixture serves as a genuine control. Done when: the inventory in the script names all 20 with their fields, and each saved genuine file decodes as an image.
- [x] Run it after the credit gate, saving each output with a label (`edit`: amount, account, date) and its provenance line in `eval/DATASETS.md`. Done 2026-11-02: 19 model-made, pair-01 code-made after its model edit failed (kind not recorded by the first version, now recorded).
- [x] Prove the pairs (plan review gap 3): each label carries a pair id, the genuine and doctored paths, the intended old and new field values, and `made_by` (`model` or `code`); the run validates the response through a zod schema, decodes each saved image, reads it back, and records whether the intended field visibly changed (the §2 extraction on the pair) and the SYNTHETIC stamp is still present. Done when: `test/node/make-doctored.test.ts` fails on a missing, corrupt, unchanged or mislabelled pair.
- [x] Bind the spend (plan review gap 4): the stated cap is the `Budget` the script passes to `metaRaw` over the shared ledger (`localBudget`), counting every attempt including retries and earlier runs; a resumed run reuses completed pairs and never re-sends them. Done when: the mocked test proves a dry run sends nothing, an exhausted budget prevents transport, and a restart spends nothing on completed pairs.
- [x] Handle refusals and failures distinctly (plan review gap 5): a content-policy refusal is recorded with its attempt and cost, never retried with a reformulated prompt, and its pair is made in code; authentication, budget, transport and malformed-response failures stop the run with completed pairs preserved and the incomplete state reported. Done when: the mocked test drives each kind.
- [x] Measure honestly (plan review gap 6): the frontier entry records, per pair, the §2 extraction's read of the doctored field (caught or missed) over genuine and doctored denominators, with PDF forensics stated `unavailable` for raster images, never counted as clean. Done when: the entry names each denominator and the unavailable count.
- [x] Record cost, refusals and how often forensics alone catches an image edit in `docs/frontier-log.md`. Done 2026-11-02: `docs/frontier-log.md`, US$0.6161 counted of the US$1.00 cap.
- [x] Commit: `eval: Muse Image doctored payment documents`

**Test checkpoint:** `python3 -c "import json;d=json.load(open('eval/sets/payment-docs/labels.json'));print(len(d))"` prints `40`, and `pnpm exec vitest run test/node/make-doctored.test.ts` passes.

> **Verified:** 2026-11-02 | §4 | 0f0c30c4cf99a24e5146f305c035d102c3fa630d
> **Review:** `docs/reviews/d06-t02-s4.json`

## 5. More PDF encodings and protected files

§1 reads unfiltered and FlateDecode streams (with PNG predictors) and leaves an encrypted file's metadata and pages unread, saying so in its coverage (the completion review of §1, `docs/reviews/06-invoice/D06-T02-s1.md`, Part 2 item 4). Real bank and accounting systems also write LZW, ASCII85, ASCIIHex and RunLength streams, TIFF predictors, and files encrypted with an empty user password (RC4 or AES, ISO 32000-1 section 7.6), which open without a password and should be read in full.

> **Started:** 2026-10-31T18:13Z

**Corrected 2026-10-31** (at start, checked against the repository and the tools on hand): (1) the fixtures come from an encoder independent of the code under test, as §1's do: Ghostscript 10.06's own PostScript filters (`/LZWEncode`, `/ASCII85Encode`, `/ASCIIHexEncode`, `/RunLengthEncode`) write each encoded stream, and Ghostscript `pdfwrite` writes the empty-user-password files, made by `test/node/make-pdf-forensics.ts` and recorded in `test/fixtures/pdf-forensics/PROVENANCE.md`; (2) Ghostscript writes only RC4 encryption (revisions 2 and 3; it refuses 4 and 6), and no other independent generator is on hand (no qpdf, pikepdf or working PyMuPDF), so AES (revision 4's AES-128 and revision 6's AES-256) moves to §6, which waits for one rather than testing a decoder against fixtures its own author wrote; this section reads RC4 files; (3) Web Crypto has no RC4, so RC4 is a small implementation of its own here, and the key derivation's MD5 (algorithm 2) is the Workers runtime's `crypto.subtle.digest("MD5")`, checked against Node's `md5` in the test.

**Corrected 2026-10-31** (plan review, 2 P1, 1 P2, 1 P3, `docs/reviews/06-invoice/D06-T02-s5.md`): (4) a decoded or decrypted file is proven read, not only findings-equal: each fixture comes as a genuine and a doctored twin, the test asserts the exact recovered page text and Info and XMP metadata, the doctored twin's expected nonempty findings, and coverage `ran` with no decoding or encryption reason; for RC4 the strings, the page content streams and an object's earlier revision read through `definitionAt` are each decrypted, so decrypting only the current streams cannot pass; (5) the new decoders work inside the shared `Budget`, charged per output byte as they run: an LZW and a RunLength expansion fixture, and several streams that together pass the cap, each stop before buffering past it, throw nothing, and leave a named partial coverage reason, and the tests fail with the charging removed; (6) each new decoder has a malformed or truncated fixture, a two-filter chain fails in its second stage, and a malformed encryption dictionary and an unsupported one (an unknown handler or revision) each give a named refusal with no throw and no clean coverage for what went unread; (7) the build step names RC4 only, AES being §6's.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Extend `streamData` in `src/invoice/pdf.ts` and add the standard security handler with an empty user password. Done when: each new filter and an empty-password RC4 file read as correction 4 proves (**Corrected 2026-10-31:** was "RC4 and AES ... same findings", correction 7).

- [x] Decode `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode` and `RunLengthDecode` (ISO 32000-1 section 7.4) and filter chains, inside the shared `Budget`. Done when: `test/invoice/pdf-filters.test.ts` reads one genuine and doctored fixture pair per filter and a two-filter chain with the exact text, metadata and findings of correction 4, the budget cases of correction 5 stop bounded with a named reason, and a malformed fixture per filter and a chain failing in its second stage each give a named reason (corrections 4 to 6).
- [x] Undo TIFF predictor 2 (section 7.4.4.4). Done when: a TIFF-predicted cross-reference stream reads like its PNG twin.
- [x] Read files encrypted with an empty user password through the standard security handler (section 7.6.3, revisions 2 and 3, RC4) (**Corrected 2026-10-31:** was revisions 2 to 4 and AES-256 revision 6; AES moves to §6, correction 2), never guessing a non-empty password. Done when: an empty-password RC4 fixture of each revision reads its strings, page streams and an earlier revision's object exactly (correction 4), a password-protected one keeps its `unavailable` coverage, and a malformed and an unsupported encryption dictionary each give a named refusal (correction 6).
- [x] Commit: `invoice: PDF forensics on more encodings and protected files`

**Test checkpoint:** `pnpm exec vitest run test/invoice/pdf-filters.test.ts` passes and fails if any filter falls back to unread.

> **Verified:** 2026-10-31 | §5 | 5913647908d39eeae8aa8bfe577ef8e2c6551cc9
> **Review:** `docs/reviews/d06-t02-s5.json`

## 6. AES-encrypted PDFs, empty password

Filed 2026-10-31 from §5's start (correction 2): a bank or accounting system that encrypts with AES (the standard security handler's revision 4 with AES-128, ISO 32000-1 section 7.6.3, and revision 6 with AES-256, ISO 32000-2) and an empty user password writes a file that opens without a password and should be read in full, as §5 reads RC4 ones. No independent generator of such files is on hand (Ghostscript writes RC4 only), so this section waits for one: qpdf, or pikepdf over it, installed for fixture generation only.

> **Started:** 2026-10-31T22:59Z

**Corrected 2026-11-01** (at start, checked against the tools on hand and §5's own lessons): (1) the generator is pikepdf 10.17.0 over qpdf 12.4.2 (MPL-2.0 and Apache-2.0), installed in a scratch virtual environment under `local-tool-safety` (user-level, outside the repository, no qpdf command on the machine); a Python maker, `test/node/make-pdf-aes.py`, encrypts Ghostscript's own proof of payment and its doctored variants from §1 and §5 into `test/fixtures/pdf-encodings/` (AES-128 revision 4 and AES-256 revision 6, an empty user password, and one AES-256 file that needs a password), recorded in that folder's `PROVENANCE.md`; (2) qpdf writes a file as one revision, so a doctored twin is a change the content shows (an image pasted over the amount, a substituted font, a later modification date), each finding needing the decrypted pages and metadata; the earlier-revision proof stays §5's; (3) as §5's correction 4: each file reads its exact page text, Info strings and XMP, its strings, its streams and its object streams each decrypted, coverage `ran` with no encryption reason; a password-protected one keeps its named, `unavailable` coverage; (4) AES decryption is charged to the shared budget like RC4's (§5 rounds 3 and 4), and a ciphertext that is not a whole number of blocks or whose padding fails is a named damaged stream, never a throw; (5) Web Crypto's AES-CBC always strips PKCS#7 padding, so revision 6's unpadded steps (the `UE` key and algorithm 2.B's rounds) are done by appending the encrypted padding block, all through Web Crypto, no own AES; (6) `/EncryptMetadata false` leaves the metadata stream as stored, and the `Identity` crypt filter means not encrypted.

**Corrected 2026-11-01** (plan review, 2 P1 and 1 P2, `docs/reviews/06-invoice/D06-T02-s6.md`): (7) correction 1's source is `test/fixtures/pdf-forensics/gs-genuine-pop.pdf` (the same proof of payment in plain form; opening the RC4 file mangles its XMP, which Ghostscript stores unencrypted), and the maker and its fixtures are `test/node/make-pdf-aes.py` and `test/fixtures/pdf-encodings/` (the first item named `make-pdf-forensics.ts` and `pdf-forensics/`); (8) correction 2 is withdrawn: earlier revisions are proven for AES too. Each of `aes-r4.pdf` and `aes-r6.pdf` gets two incremental updates written by the maker after qpdf's file: `-edited` replaces the page content with the amount drawn over, `-resaved` rewrites the Info dictionary with its own values; each update is encrypted with `cryptography`'s AES-CBC (a random IV, PKCS#7 padding) under the file key qpdf reports through pikepdf (`encryption_key`), with the revision 4 object key of ISO 32000-1 algorithm 1 and `sAlT`, and the revision 6 file key as it is; the earlier revision is qpdf's own. The tests assert, as §5's RC4 ones, the exact strings and streams of both revisions through `definitionAt`, the edit found in `-edited`, and `-resaved` giving the same findings as the same save on the plain twin; (9) crypt filters are chosen before decryption and applied once: strings by `/StrF`, streams by `/StmF` unless the stream's own `/Filter` names `/Crypt`, whose `/DecodeParms /Name` selects from `/CF` (`/Identity` meaning stored as is), the `/Crypt` filter then dropped from the decode chain; a selection naming no `/CF` entry, a `/CFM` other than `/AESV2`, `/AESV3`, `/V2` or `/None`, or a revision 5 file is named and leaves the file unread, never decoded as data. The maker writes `aes-r4-nometa.pdf` and `aes-r6-nometa.pdf` with qpdf (`/EncryptMetadata false`), and three revision 4 files of its own, each checked by qpdf opening it and reading the same strings and streams back: `aes-r4-strings-only.pdf` (`/StmF /Identity`), `aes-r4-crypt-identity.pdf` (one stream with an explicit `/Crypt` `/Identity` filter, stored plain, the rest encrypted) and `aes-r4-unknown-filter.pdf` (`/StmF` naming a filter not in `/CF`); (10) the budget and damaged input get their own tests in `test/invoice/pdf-filters.test.ts`, built from the fixtures as §5's rounds 3 and 4 were: a later save adding a 1 MiB AES stream read on every access and one adding a 1 MiB AES string, refused at the shared budget before the decryption runs, and failing with the charge removed; an IV shorter than 16 bytes, ciphertext not a whole number of blocks, padding that fails, a damaged encrypted string, and a malformed encryption dictionary (a `/UE` or `/U` of the wrong length, `/R 5`, no `/CF`), each a named reason, nothing escaping `readPdf` or `analysePdf`, and coverage never a clean `ran`.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Read AES-encrypted files with an empty user password. Done when: an AES-128 and an AES-256 fixture from an independent generator read to their plain twins' findings.

- [x] Write `test/node/make-pdf-aes.py` (**Corrected 2026-11-01:** was an AES generator in `test/node/make-pdf-forensics.ts` with its provenance in `test/fixtures/pdf-forensics/`; corrections 1 and 7): pikepdf over qpdf encrypts `gs-genuine-pop.pdf` into `aes-r4.pdf`, `aes-r6.pdf`, `aes-r4-nometa.pdf`, `aes-r6-nometa.pdf` and `aes-password.pdf`, each written to a temporary name and moved into place, then opened again by qpdf and its Title read back. Done when: the five files are in `test/fixtures/pdf-encodings/` and `PROVENANCE.md` names pikepdf 10.17.0, qpdf 12.4.2 and their licences.
- [x] Add the incremental updates of correction 8 to the maker: `aes-r4-edited.pdf`, `aes-r6-edited.pdf`, `aes-r4-resaved.pdf` and `aes-r6-resaved.pdf`, each update encrypted with `cryptography` under the key qpdf reports, and each file opened by qpdf with its Title and page content read back. Done when: qpdf reads every edited file's current page content with the amount drawn over, and `PROVENANCE.md` names `cryptography` 50.0.2.
- [x] Add the three crypt-filter files of correction 9 to the maker, each checked by qpdf reading its strings and streams back. Done when: qpdf opens `aes-r4-strings-only.pdf` and `aes-r4-crypt-identity.pdf` to the plain twin's page text (**Corrected 2026-11-01:** was also "and refuses or names `aes-r4-unknown-filter.pdf`'s missing filter"; qpdf opens that file, falling back silently, as `PROVENANCE.md` records, so the reader's naming of it is proven by its own test).
- [x] Choose each string's and stream's crypt filter before decrypting (correction 9), then decrypt AES-128 (revision 4, the `AESV2` crypt filter) and AES-256 (revision 6, `AESV3`, the SHA-2 hash of ISO 32000-2 algorithm 2.B) through Web Crypto in `src/invoice/pdf.ts`, never guessing a non-empty password. Done when: `test/invoice/pdf-filters.test.ts` reads `aes-r4.pdf`, `aes-r6.pdf`, both `-nometa` files, `aes-r4-strings-only.pdf` and `aes-r4-crypt-identity.pdf` to the plain twin's text, Info and XMP with every check `ran`, both revisions of each `-edited` and `-resaved` file as correction 8 says, and names `aes-r4-unknown-filter.pdf` and `aes-password.pdf` as unread with their checks `unavailable`.
- [x] Charge AES decryption to the shared budget and name every damaged input (correction 10) in `src/invoice/pdf.ts`. Done when: the budget and damaged-input tests of correction 10 pass, and the budget ones fail with the charge removed.
- [x] Commit: `invoice: PDF forensics on AES-encrypted files`

**Test checkpoint:** `pnpm exec vitest run test/invoice/pdf-filters.test.ts` passes, and fails if an AES file with an empty user password is left unread, if an earlier AES revision is not decrypted, if a crypt filter is chosen wrongly, or if AES decryption is not charged to the budget.

> **Verified:** 2026-11-01 | §6 | 2363443f5722692d1efb9971aa19041e61690fde
> **Review:** `docs/reviews/d06-t02-s6.json`

## 7. Diverse doctored pairs with verified truth

The §4 set shares one sparse template and confounds document type with edit type (every invoice changes an account, every POP an amount, every letter a date). A benchmark-grade set needs structurally distinct layouts per document type, all nine type/edit combinations, and ground truth verified independently of the generator's intention (D06 T02 §4 completion review, filed 2026-11-02; its spend needs a cap stated by the coordinator before any paid call, since §4's US$1.00 is counted to US$0.6161).

**Phase:** 7
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Generate the diverse set. Done when: three structurally distinct layouts (one per document type) hold all nine type/edit combinations with verified labels.

- [ ] Draw three layouts in the §4 generator (a table invoice, a bank POP slip, a letter), varying field positions and typography per type. Done when: the genuine files decode and visibly differ in structure per type.
- [ ] Represent all nine document-type/edit combinations across the set. Done when: the labels name each combination at least twice.
- [ ] Verify ground truth independently: a reviewer pass (the §2 extraction plus a visual read of each pair) confirms only the named field changed, the SYNTHETIC stamp is retained, and non-target content is unchanged, recorded per pair. Done when: every pair carries a verified mark or is regenerated.
- [ ] Score genuine controls on their original values and doctored twins on their new values in the measurement, with failures kept in the denominators. Done when: the frontier entry names per-field accuracy for both roles.
- [ ] Commit: `eval: diverse doctored pairs with verified truth`

**Test checkpoint:** `pnpm exec vitest run test/node/make-doctored.test.ts` passes and the labels name all nine combinations.

## 8. Native PDF forensic limits diagnosis

Coordinator scope correction `console-scope-ownership`, 2026-11-04 10:14 SAST: the originally assigned detector repair becomes a narrow diagnosis and semantic regression section after reproduction found intentional single-signal limits, not established parser defects. The source baseline remains 3/7 detections, 0/7 false positives and 13/14 complete; proof-of-payment 1/5 and Ghostscript 0/4. The Chromium invoice has an invoice date but no payment date. Original assignment and review history remain in git; no prior section review has run. Completing this diagnosis is not detection improvement or target attainment.

> **Started:** 2026-11-04T08:32:12.097588+00:00

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Pin and reproduce the native-PDF baseline. Done when: all 14 original hashes/labels and per-file outcomes are recorded from eval's exact corpus with the scorer and detector source identified.
2. Protect the diagnosed limits with falsifiable tests. Done when: the four Ghostscript edits each retain exactly their intended independent medium signal, genuine controls remain non-detections, and missing payment date remains unavailable.
3. Return the measured limits to eval. Done when: denominators, missing coverage and unchanged 95 percent detection target and complete-coverage requirement are explicit, with no invented corroboration or sample exclusions.

- [ ] Record the exact labelled native-PDF baseline in `docs/pdf-forensics-repair.md`. Done when: artifact hashes, generator provenance, labels, per-file findings/coverage and reproducible scorer command substantiate 3/7 detections, 0/7 false positives and 13/14 complete. Cheaper substitute: treating a coordinator summary as a new measurement. Source: D08 T02 §6 evaluation and coordinator scope correction.
- [ ] Extend `test/invoice/forensics-generated.test.ts` using the existing eight unchanged Ghostscript/Chromium fixtures to assert actual evidence severities and coverage, not only finding kinds. Done when: four doctored Ghostscript files remain single medium findings and no genuine fixture reaches high/critical; promoting a single independent group to high makes the tests fail. Cheaper substitute: weakening the detector threshold to improve synthetic detection counts. Source: existing independent-evidence contract and coordinator scope correction.
- [ ] Assert the missing payment date in `test/invoice/forensics-generated.test.ts` and record its source in `docs/pdf-forensics-repair.md`. Done when: the Chromium invoice's date coverage is unavailable with its concrete reason, the other seven generated fixtures have full coverage, and changing missing-date coverage to ran makes the test fail. Cheaper substitute: treating invoice date as a payment date or calling unavailable coverage complete. Source: `test/node/make-pdf-forensics.ts` and `src/invoice/forensics.ts` date semantics.
- [ ] Document unresolved targets and supported follow-up opportunities in `docs/pdf-forensics-repair.md` without altering `src/invoice/` production policy or eval-owned data. Done when: diagnosis is clearly distinguished from repair, 95 percent detection target and complete-coverage requirement remain unmet, no unsupported new detector is promised, and eval receives the exact diagnostic commit. Cheaper substitute: equating passing semantic tests with detection improvement. Source: coordinator scope correction.
- [ ] Commit: `invoice: document native PDF forensic limits with regression proof`

**Test checkpoint:** `pnpm exec vitest run --project worker test/invoice/forensics-generated.test.ts test/invoice/pdf-filters.test.ts` passes; the single-signal promotion and missing-date-as-complete mutations fail, with production source restored afterward. The pinned eval scorer reproduces the unchanged 14-file baseline; local tests do not claim a measured production accuracy improvement.

## 9. PNG encoding at the doctored fixture producer

> **Started:** 2026-11-04T07:31:43.896386+00:00

Coordinator scoped authority 2026-11-04: own the narrow shared producer `scripts/fixtures/make-doctored.ts`, targeted tests and existing payment-document artifacts. Nineteen provider WebP images were stored under PNG names. Preserve original provenance and original bytes through git history and an external backup, normalize losslessly without new model calls, and record every hash change. Native-PDF detection remains §8.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Add a regression for non-PNG provider bytes in `test/node/make-doctored.test.ts`. Done when: the existing producer fails the real-PNG assertion.
2. Normalize accepted provider bytes in `scripts/fixtures/make-doctored.ts`. Done when: newly saved PNG fixtures decode with the same pixels as the provider image and restart preserves provenance.
3. Repair the existing corpus through the same normalization. Done when: every renamed-format artifact has recorded before/after hashes, formats and pixel equivalence.

- [x] Add producer regressions to `test/node/make-doctored.test.ts` for WebP input, invalid/truncated image data, unchanged output and restart provenance. Done when: real PNG bytes are required and invalid input cannot become a mislabeled completed image.
- [x] Encode accepted provider images with explicit PNG output in `scripts/fixtures/make-doctored.ts`. Done when: PNG signature and full decoding pass before publication, with original model/code attribution retained. Cheaper substitute: changing MIME claims or filenames without fixing the producer. Source: coordinator scoped-repair-authority.
- [x] Add an explicit offline normalization operation in `scripts/fixtures/make-doctored.ts` using the same encoder. Done when: it validates decoded-pixel equivalence, records original/current SHA-256 and format, handles already-PNG input idempotently and never calls a model. Cheaper substitute: silently replacing artifact bytes. Source: coordinator scoped-repair-authority.
- [x] Normalize the 19 affected `test/fixtures/payment-docs/` images and add `normalization.json` evidence. Done when: actual formats are PNG, dimensions and decoded pixels are unchanged, and existing labels/sidecar provenance remain byte-exact. Cheaper substitute: regenerating model images or relabelling ground truth. Source: coordinator scoped-repair-authority.
- [x] Record verification and notify eval in `docs/payment-fixture-normalization.md`. Done when: the exact corrected candidate and changed hashes are available, with no claim that raster normalization improves native-PDF detection. Cheaper substitute: reusing stale evaluation receipts.
- [x] Prove durable recovery in `test/node/make-doctored.test.ts`: verified external backups and original-hash records precede atomic replacement; interruption after replacement or a failed write retains the original evidence on restart. Done when: fault injection recovers the same original hashes and bytes. Cheaper substitute: recomputing a source hash from already-normalized bytes. Source: Codex plan self-review P2-1.
- [x] Compare decoded pixels for unchanged provider output in `scripts/fixtures/make-doctored.ts`. Done when: a lossless WebP encoding of the genuine PNG is attributed to the existing code fallback, never to a model edit. Cheaper substitute: encoded-byte equality. Source: Codex plan self-review P2-2.
- [x] Commit: `fixtures: encode doctored payment images as PNG`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/make-doctored.test.ts` passes, fails on non-PNG saved output before the fix, and the corpus normalization record proves all 19 repairs without pixel changes.

> **Verified:** 2026-11-04 | §9 | a4e04dad45e02ba03e64d6ffa61e9c789b959301
> **Review:** `docs/reviews/d06-t02-s9.json`

## Verification

- Doctored documents are flagged by forensics and extraction; every POP verdict carries the fixed action and the limit.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
